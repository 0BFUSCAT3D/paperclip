use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const RUNNER_STREAM_SCHEMA: &str = "paperclip.runner.stream.v1";
const RUNNER_COMMAND_SCHEMA: &str = "paperclip.prp.command.v1";
const HARNESS_COMMAND_SCHEMA: &str = "paperclip.fake_harness.command.v1";
const HARNESS_MESSAGE_SCHEMA: &str = "paperclip.fake_harness.message.v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Phase2Error(String);

impl Phase2Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for Phase2Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for Phase2Error {}

#[derive(Clone, Debug)]
pub struct RunnerConfig {
    pub run_id: String,
    pub normalized_session_id: String,
    pub runner_instance_id: String,
    pub fake_harness_path: PathBuf,
    pub script_path: PathBuf,
    pub delay_override_ms: Option<u64>,
    pub log_max_lines: usize,
    pub log_max_bytes: usize,
    pub shutdown_grace: Duration,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerCommand {
    pub schema: String,
    pub command_id: String,
    pub controller_seq: u64,
    #[serde(rename = "type")]
    pub command_type: String,
    pub issued_at: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCommand {
    pub schema: String,
    pub command_id: String,
    #[serde(rename = "type")]
    pub command_type: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessMessage {
    schema: String,
    message_seq: u64,
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeHarnessScript {
    pub schema: String,
    pub name: String,
    pub steps: Vec<FakeHarnessStep>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FakeHarnessStep {
    Delay {
        milliseconds: u64,
    },
    Log {
        stream: String,
        text: String,
    },
    Event {
        event_type: String,
        #[serde(default)]
        turn_id: Option<String>,
        #[serde(default)]
        item_id: Option<String>,
        #[serde(default)]
        payload: Value,
    },
    Request {
        request: Value,
    },
    AwaitResolution {
        request_id: String,
    },
    AwaitInterrupt,
    Result {
        payload: Value,
    },
    Terminal {
        payload: Value,
    },
    SpawnWorker,
    Exit {
        code: i32,
    },
}

#[derive(Debug)]
enum ProcessOutput {
    Stdout(String),
    Stderr(String),
    StdoutClosed,
    StderrClosed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExitFact {
    pub exit_code: Option<i32>,
    pub success: bool,
    pub signal: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundedLogSnapshot {
    pub lines: Vec<String>,
    pub retained_bytes: usize,
    pub dropped_lines: usize,
}

#[derive(Debug)]
pub struct BoundedLogBuffer {
    max_lines: usize,
    max_bytes: usize,
    retained_bytes: usize,
    dropped_lines: usize,
    lines: VecDeque<String>,
}

impl BoundedLogBuffer {
    pub fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            max_lines: max_lines.max(1),
            max_bytes: max_bytes.max(1),
            retained_bytes: 0,
            dropped_lines: 0,
            lines: VecDeque::new(),
        }
    }

    pub fn push(&mut self, line: impl Into<String>) {
        let mut line = line.into();
        if line.len() > self.max_bytes {
            let mut end = self.max_bytes;
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            line.truncate(end);
        }
        self.retained_bytes += line.len();
        self.lines.push_back(line);
        while self.lines.len() > self.max_lines || self.retained_bytes > self.max_bytes {
            if let Some(removed) = self.lines.pop_front() {
                self.retained_bytes = self.retained_bytes.saturating_sub(removed.len());
                self.dropped_lines += 1;
            } else {
                break;
            }
        }
    }

    pub fn snapshot(&self) -> BoundedLogSnapshot {
        BoundedLogSnapshot {
            lines: self.lines.iter().cloned().collect(),
            retained_bytes: self.retained_bytes,
            dropped_lines: self.dropped_lines,
        }
    }
}

pub struct SupervisedProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    output: Receiver<ProcessOutput>,
    process_group_id: u32,
    shutdown_grace: Duration,
    finished: bool,
}

impl SupervisedProcess {
    pub fn spawn(
        program: &Path,
        args: &[String],
        shutdown_grace: Duration,
    ) -> Result<Self, Phase2Error> {
        let mut command = Command::new(program);
        command
            .args(args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        #[cfg(unix)]
        command.process_group(0);

        let mut child = command.spawn().map_err(|error| {
            Phase2Error::invalid(format!(
                "failed to start supervised process {}: {error}",
                program.display()
            ))
        })?;
        let process_group_id = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Phase2Error::invalid("supervised process stdin was not piped"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Phase2Error::invalid("supervised process stdout was not piped"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Phase2Error::invalid("supervised process stderr was not piped"))?;
        let (sender, output) = mpsc::channel();
        let stdout_sender = sender.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if stdout_sender.send(ProcessOutput::Stdout(line)).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = stdout_sender.send(ProcessOutput::Stderr(format!(
                            "failed to read harness stdout: {error}"
                        )));
                        break;
                    }
                }
            }
            let _ = stdout_sender.send(ProcessOutput::StdoutClosed);
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => {
                        if sender.send(ProcessOutput::Stderr(line)).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(ProcessOutput::Stderr(format!(
                            "failed to read harness stderr: {error}"
                        )));
                        break;
                    }
                }
            }
            let _ = sender.send(ProcessOutput::StderrClosed);
        });

        Ok(Self {
            child,
            stdin: Some(stdin),
            output,
            process_group_id,
            shutdown_grace,
            finished: false,
        })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn send<T: Serialize>(&mut self, value: &T) -> Result<(), Phase2Error> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| Phase2Error::invalid("supervised process stdin is closed"))?;
        serde_json::to_writer(&mut *stdin, value).map_err(|error| {
            Phase2Error::invalid(format!("command serialization failed: {error}"))
        })?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| {
                Phase2Error::invalid(format!("failed to write process command: {error}"))
            })
    }

    fn recv_timeout(&self, timeout: Duration) -> Result<ProcessOutput, RecvTimeoutError> {
        self.output.recv_timeout(timeout)
    }

    pub fn receive_stdout_line(&self, timeout: Duration) -> Result<Option<String>, Phase2Error> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            match self.recv_timeout(remaining) {
                Ok(ProcessOutput::Stdout(line)) => return Ok(Some(line)),
                Ok(ProcessOutput::Stderr(_)) | Ok(ProcessOutput::StderrClosed) => {}
                Ok(ProcessOutput::StdoutClosed) => return Ok(None),
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(Phase2Error::invalid("process output channel closed"));
                }
            }
        }
    }

    fn try_recv(&self) -> Result<ProcessOutput, mpsc::TryRecvError> {
        self.output.try_recv()
    }

    pub fn try_wait(&mut self) -> Result<Option<ProcessExitFact>, Phase2Error> {
        self.child
            .try_wait()
            .map(|status| status.map(exit_fact))
            .map_err(|error| Phase2Error::invalid(format!("failed to inspect process: {error}")))
    }

    pub fn wait(&mut self) -> Result<ProcessExitFact, Phase2Error> {
        let status = self.child.wait().map_err(|error| {
            Phase2Error::invalid(format!("failed to wait for process: {error}"))
        })?;
        self.finished = true;
        Ok(exit_fact(status))
    }

    pub fn terminate_group(&mut self) -> Result<ProcessExitFact, Phase2Error> {
        self.stdin.take();
        #[cfg(unix)]
        signal_process_group(self.process_group_id, "TERM");
        #[cfg(not(unix))]
        let _ = self.child.kill();

        let deadline = Instant::now() + self.shutdown_grace;
        loop {
            if let Some(fact) = self.try_wait()? {
                #[cfg(unix)]
                signal_process_group(self.process_group_id, "KILL");
                self.finished = true;
                return Ok(fact);
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }

        #[cfg(unix)]
        signal_process_group(self.process_group_id, "KILL");
        #[cfg(not(unix))]
        let _ = self.child.kill();
        self.wait()
    }
}

impl Drop for SupervisedProcess {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.terminate_group();
        }
    }
}

#[cfg(unix)]
fn signal_process_group(process_group_id: u32, signal: &str) {
    let _ = Command::new("kill")
        .args([
            format!("-{signal}"),
            "--".to_owned(),
            format!("-{process_group_id}"),
        ])
        .env_clear()
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn exit_fact(status: ExitStatus) -> ProcessExitFact {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        ProcessExitFact {
            exit_code: status.code(),
            success: status.success(),
            signal: status.signal(),
        }
    }
    #[cfg(not(unix))]
    {
        ProcessExitFact {
            exit_code: status.code(),
            success: status.success(),
            signal: None,
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RunnerStreamMessage<'a> {
    Event {
        event: &'a Value,
    },
    CommandReceipt {
        #[serde(rename = "commandId")]
        command_id: &'a str,
        #[serde(rename = "controllerSeq")]
        controller_seq: u64,
        status: &'a str,
        detail: &'a str,
    },
    Diagnostic {
        level: &'a str,
        message: &'a str,
    },
}

struct RunnerState {
    config: RunnerConfig,
    source_seq: u64,
    next_controller_seq: u64,
    commands: HashMap<String, String>,
    harness: Option<SupervisedProcess>,
    logs: BoundedLogBuffer,
    semantic_result: Option<Value>,
    pending_terminal: Option<Value>,
    terminal_emitted: bool,
    stdout_closed: bool,
}

impl RunnerState {
    fn new(config: RunnerConfig) -> Self {
        Self {
            logs: BoundedLogBuffer::new(config.log_max_lines, config.log_max_bytes),
            config,
            source_seq: 0,
            next_controller_seq: 1,
            commands: HashMap::new(),
            harness: None,
            semantic_result: None,
            pending_terminal: None,
            terminal_emitted: false,
            stdout_closed: false,
        }
    }

    fn write_stream(&self, message: &RunnerStreamMessage<'_>) -> Result<(), Phase2Error> {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        let envelope = json!({
            "schema": RUNNER_STREAM_SCHEMA,
            "message": message,
        });
        serde_json::to_writer(&mut lock, &envelope).map_err(|error| {
            Phase2Error::invalid(format!("stream serialization failed: {error}"))
        })?;
        lock.write_all(b"\n")
            .and_then(|_| lock.flush())
            .map_err(|error| Phase2Error::invalid(format!("stream write failed: {error}")))
    }

    fn command_receipt(
        &self,
        command: &RunnerCommand,
        status: &str,
        detail: &str,
    ) -> Result<(), Phase2Error> {
        self.write_stream(&RunnerStreamMessage::CommandReceipt {
            command_id: &command.command_id,
            controller_seq: command.controller_seq,
            status,
            detail,
        })
    }

    fn diagnostic(&self, level: &str, message: &str) -> Result<(), Phase2Error> {
        self.write_stream(&RunnerStreamMessage::Diagnostic { level, message })
    }

    fn emit_event(
        &mut self,
        event_type: &str,
        payload: Value,
        turn_id: Option<&str>,
        item_id: Option<&str>,
    ) -> Result<(), Phase2Error> {
        if self.terminal_emitted {
            return Ok(());
        }
        self.source_seq += 1;
        let mut event = json!({
            "schema": "paperclip.prp.event.v1",
            "sourceEventId": format!("event_{}_{:03}", self.config.run_id, self.source_seq),
            "sourceSeq": self.source_seq,
            "sourceInstanceId": self.config.runner_instance_id,
            "sourceKind": "runner",
            "runId": self.config.run_id,
            "normalizedSessionId": self.config.normalized_session_id,
            "eventType": event_type,
            "schemaVersion": 1,
            "priority": event_priority(event_type),
            "emittedAt": format!("2026-08-07T21:00:{:02}.{:03}Z", (self.source_seq / 1000) % 60, self.source_seq % 1000),
            "payload": payload,
        });
        if let Some(turn_id) = turn_id {
            event["turnId"] = Value::String(turn_id.to_owned());
        }
        if let Some(item_id) = item_id {
            event["itemId"] = Value::String(item_id.to_owned());
        }
        self.write_stream(&RunnerStreamMessage::Event { event: &event })?;
        if event_type == "run.terminal" {
            self.terminal_emitted = true;
        }
        Ok(())
    }

    fn start_harness(&mut self) -> Result<(), Phase2Error> {
        self.emit_event(
            "runtime.phase.changed",
            json!({ "phase": "workspace_preparing" }),
            None,
            None,
        )?;
        self.emit_event(
            "workspace.ready",
            json!({ "workingDirectory": "standalone-fixture" }),
            None,
            None,
        )?;
        self.emit_event(
            "harness.starting",
            json!({ "driverKind": "fake", "transport": "stdio_jsonl" }),
            None,
            None,
        )?;
        let mut args = vec![
            "--script".to_owned(),
            self.config.script_path.display().to_string(),
        ];
        if let Some(milliseconds) = self.config.delay_override_ms {
            args.push("--delay-ms".to_owned());
            args.push(milliseconds.to_string());
        }
        let harness = SupervisedProcess::spawn(
            &self.config.fake_harness_path,
            &args,
            self.config.shutdown_grace,
        )?;
        let ready_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = ready_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Phase2Error::invalid("fake harness did not become ready"));
            }
            match harness.recv_timeout(remaining) {
                Ok(ProcessOutput::Stdout(line)) => {
                    let message = parse_harness_message(&line)?;
                    if message.message_type == "ready" {
                        self.emit_event(
                            "harness.ready",
                            json!({
                                "driverKind": "fake",
                                "driverVersion": message.payload.get("version").cloned().unwrap_or_else(|| json!("1.0.0")),
                                "transport": "stdio_jsonl"
                            }),
                            None,
                            None,
                        )?;
                        break;
                    }
                    return Err(Phase2Error::invalid(
                        "fake harness emitted data before ready",
                    ));
                }
                Ok(ProcessOutput::Stderr(line)) => self.logs.push(format!("stderr: {line}")),
                Ok(ProcessOutput::StdoutClosed) => {
                    return Err(Phase2Error::invalid("fake harness exited before ready"));
                }
                Ok(ProcessOutput::StderrClosed) => {}
                Err(RecvTimeoutError::Timeout) => {
                    return Err(Phase2Error::invalid("fake harness ready timed out"));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(Phase2Error::invalid("fake harness output channel closed"));
                }
            }
        }
        self.harness = Some(harness);
        Ok(())
    }

    fn handle_command(&mut self, command: RunnerCommand) -> Result<(), Phase2Error> {
        if command.schema != RUNNER_COMMAND_SCHEMA {
            self.command_receipt(&command, "rejected", "unsupported command schema")?;
            return Ok(());
        }
        let canonical = canonical_json(&serde_json::to_value(&command).map_err(|error| {
            Phase2Error::invalid(format!("command canonicalization failed: {error}"))
        })?);
        if let Some(previous) = self.commands.get(&command.command_id) {
            if previous == &canonical {
                self.command_receipt(&command, "duplicate", "equivalent command already applied")?;
            } else {
                self.command_receipt(
                    &command,
                    "rejected",
                    "commandId was reused with different data",
                )?;
            }
            return Ok(());
        }
        if command.controller_seq != self.next_controller_seq {
            self.command_receipt(&command, "rejected", "controllerSeq is not contiguous")?;
            return Ok(());
        }
        self.commands.insert(command.command_id.clone(), canonical);
        self.next_controller_seq += 1;

        match command.command_type.as_str() {
            "run.prepare" => {
                if self.harness.is_some() {
                    self.command_receipt(&command, "rejected", "run is already prepared")?;
                    return Ok(());
                }
                self.start_harness()?;
            }
            "session.open" => {
                self.emit_event("session.starting", json!({}), None, None)?;
                self.send_harness_command(&command)?;
            }
            "turn.start" => {
                self.emit_event(
                    "turn.submitted",
                    json!({ "text": command.payload.get("text").cloned().unwrap_or(Value::Null) }),
                    command.payload.get("turnId").and_then(Value::as_str),
                    None,
                )?;
                self.send_harness_command(&command)?;
            }
            "request.resolve" | "turn.interrupt" | "turn.stop" | "session.close" | "run.cancel" => {
                self.send_harness_command(&command)?;
            }
            unsupported => {
                self.command_receipt(
                    &command,
                    "rejected",
                    &format!("command {unsupported} is not implemented in Phase 2"),
                )?;
                return Ok(());
            }
        }
        self.command_receipt(&command, "accepted", "command applied")
    }

    fn send_harness_command(&mut self, command: &RunnerCommand) -> Result<(), Phase2Error> {
        let harness = self
            .harness
            .as_mut()
            .ok_or_else(|| Phase2Error::invalid("run.prepare must start the harness first"))?;
        harness.send(&HarnessCommand {
            schema: HARNESS_COMMAND_SCHEMA.to_owned(),
            command_id: command.command_id.clone(),
            command_type: command.command_type.clone(),
            payload: command.payload.clone(),
        })
    }

    fn drain_harness_output(&mut self) -> Result<(), Phase2Error> {
        loop {
            let output = match self.harness.as_ref().map(SupervisedProcess::try_recv) {
                Some(Ok(output)) => output,
                Some(Err(mpsc::TryRecvError::Empty)) | None => return Ok(()),
                Some(Err(mpsc::TryRecvError::Disconnected)) => {
                    self.stdout_closed = true;
                    return Ok(());
                }
            };
            match output {
                ProcessOutput::Stdout(line) => self.handle_harness_line(&line)?,
                ProcessOutput::Stderr(line) => self.logs.push(format!("stderr: {line}")),
                ProcessOutput::StdoutClosed => self.stdout_closed = true,
                ProcessOutput::StderrClosed => {}
            }
        }
    }

    fn handle_harness_line(&mut self, line: &str) -> Result<(), Phase2Error> {
        let message = parse_harness_message(line)?;
        match message.message_type.as_str() {
            "event" => {
                let event_type = message
                    .payload
                    .get("eventType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Phase2Error::invalid("harness event requires eventType"))?
                    .to_owned();
                let turn_id = message
                    .payload
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let item_id = message
                    .payload
                    .get("itemId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let payload = message
                    .payload
                    .get("payload")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                self.emit_event(&event_type, payload, turn_id.as_deref(), item_id.as_deref())?;
            }
            "request" => {
                let request = message
                    .payload
                    .get("request")
                    .cloned()
                    .ok_or_else(|| Phase2Error::invalid("harness request requires request"))?;
                self.emit_event(
                    "runtime_request.created",
                    json!({ "request": request }),
                    None,
                    None,
                )?;
            }
            "result" => {
                let result = message
                    .payload
                    .get("result")
                    .cloned()
                    .ok_or_else(|| Phase2Error::invalid("harness result requires result"))?;
                if self.semantic_result.is_none() {
                    self.semantic_result = Some(result.clone());
                    self.emit_event("run.result.proposed", result, None, None)?;
                } else {
                    self.emit_event(
                        "harness.diagnostic",
                        json!({
                            "code": "duplicate_semantic_result_ignored",
                            "message": "Duplicate semantic result ignored; the first result remains authoritative."
                        }),
                        None,
                        None,
                    )?;
                }
            }
            "terminal" => {
                let terminal =
                    message.payload.get("terminal").cloned().ok_or_else(|| {
                        Phase2Error::invalid("harness terminal requires terminal")
                    })?;
                if self.pending_terminal.is_none() {
                    self.pending_terminal = Some(terminal);
                } else {
                    self.emit_event(
                        "harness.diagnostic",
                        json!({
                            "code": "duplicate_terminal_ignored",
                            "message": "Duplicate terminal event ignored; the first terminal event remains authoritative."
                        }),
                        None,
                        None,
                    )?;
                }
            }
            "log" => {
                let stream = message
                    .payload
                    .get("stream")
                    .and_then(Value::as_str)
                    .unwrap_or("stdout");
                let text = message
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.logs.push(format!("{stream}: {text}"));
            }
            "diagnostic" => {
                self.logs.push(format!("diagnostic: {}", message.payload));
            }
            "ready" => {
                self.diagnostic("warning", "duplicate harness ready message ignored")?;
            }
            unsupported => {
                return Err(Phase2Error::invalid(format!(
                    "unsupported fake harness message {unsupported} at sequence {}",
                    message.message_seq
                )));
            }
        }
        Ok(())
    }

    fn finish_harness(&mut self) -> Result<(), Phase2Error> {
        let exit = self
            .harness
            .as_mut()
            .ok_or_else(|| Phase2Error::invalid("harness was not started"))?
            .wait()?;
        self.finalize_harness(exit)
    }

    fn terminate_harness(&mut self) -> Result<(), Phase2Error> {
        let exit = self
            .harness
            .as_mut()
            .ok_or_else(|| Phase2Error::invalid("harness was not started"))?
            .terminate_group()?;
        self.finalize_harness(exit)
    }

    fn finalize_harness(&mut self, exit: ProcessExitFact) -> Result<(), Phase2Error> {
        self.emit_event(
            "harness.exited",
            json!({
                "processExit": exit,
                "semanticResultObserved": self.semantic_result.is_some(),
                "logs": self.logs.snapshot(),
            }),
            None,
            None,
        )?;
        let terminal = self.pending_terminal.take().unwrap_or_else(|| {
            json!({
                "schema": "paperclip.prp.terminal.v1",
                "turnTerminalState": "failed",
                "runTerminalState": "failed",
                "reportedWorkDisposition": "yielded"
            })
        });
        self.emit_event("run.terminal", terminal, None, None)
    }
}

pub fn run_local_runner(config: RunnerConfig) -> Result<(), Phase2Error> {
    let (command_sender, command_receiver) = mpsc::channel();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let command = serde_json::from_str::<RunnerCommand>(&line);
            if command_sender.send(command).is_err() {
                break;
            }
        }
    });

    let mut state = RunnerState::new(config);
    loop {
        match command_receiver.recv_timeout(Duration::from_millis(2)) {
            Ok(Ok(command)) => state.handle_command(command)?,
            Ok(Err(error)) => {
                state.diagnostic("error", &format!("invalid command JSON: {error}"))?
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if state.harness.is_none() {
                    return Err(Phase2Error::invalid("controller closed before run.prepare"));
                }
                state.terminate_harness()?;
                return Ok(());
            }
        }
        state.drain_harness_output()?;
        if state.stdout_closed {
            state.finish_harness()?;
            return Ok(());
        }
    }
}

fn parse_harness_message(line: &str) -> Result<HarnessMessage, Phase2Error> {
    let message: HarnessMessage = serde_json::from_str(line).map_err(|error| {
        Phase2Error::invalid(format!("fake harness emitted invalid JSONL: {error}"))
    })?;
    if message.schema != HARNESS_MESSAGE_SCHEMA {
        return Err(Phase2Error::invalid(
            "fake harness message schema is unsupported",
        ));
    }
    Ok(message)
}

fn event_priority(event_type: &str) -> u8 {
    match event_type {
        "run.result.proposed"
        | "run.terminal"
        | "turn.completed"
        | "turn.failed"
        | "turn.interrupted"
        | "harness.exited" => 0,
        "item.delta" | "harness.diagnostic" | "runner.diagnostic" => 2,
        _ => 1,
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON object key should serialize"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.to_string(),
    }
}

pub fn load_fake_harness_script(path: &Path) -> Result<FakeHarnessScript, Phase2Error> {
    let input = std::fs::read_to_string(path).map_err(|error| {
        Phase2Error::invalid(format!(
            "failed to read fake harness script {}: {error}",
            path.display()
        ))
    })?;
    let script: FakeHarnessScript = serde_json::from_str(&input).map_err(|error| {
        Phase2Error::invalid(format!("fake harness script must be valid JSON: {error}"))
    })?;
    if script.schema != "paperclip.fake_harness.script.v1" {
        return Err(Phase2Error::invalid(
            "fake harness script schema is unsupported",
        ));
    }
    if script.name.trim().is_empty() || script.steps.is_empty() {
        return Err(Phase2Error::invalid(
            "fake harness script requires a name and at least one step",
        ));
    }
    Ok(script)
}

pub fn run_fake_harness(
    script: FakeHarnessScript,
    delay_override_ms: Option<u64>,
) -> Result<i32, Phase2Error> {
    let (command_sender, command_receiver) = mpsc::channel::<HarnessCommand>();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let command = match serde_json::from_str::<HarnessCommand>(&line) {
                Ok(command) => command,
                Err(_) => continue,
            };
            if command_sender.send(command).is_err() {
                return;
            }
        }
    });

    let mut output = FakeHarnessOutput::default();
    output.send(
        "ready",
        json!({ "version": "1.0.0", "script": script.name }),
    )?;
    receive_harness_command(&command_receiver, "session.open", None)?;
    output.send_event(
        "session.started",
        None,
        None,
        json!({ "driverSessionId": "driver_phase2_fake" }),
    )?;
    output.send_event(
        "runtime.phase.changed",
        None,
        None,
        json!({ "phase": "executing" }),
    )?;
    let turn = receive_harness_command(&command_receiver, "turn.start", None)?;
    let turn_id = turn
        .payload
        .get("turnId")
        .and_then(Value::as_str)
        .unwrap_or("turn_phase2")
        .to_owned();
    output.send_event("turn.started", Some(&turn_id), None, json!({}))?;

    let mut workers = Vec::<Child>::new();
    for step in script.steps {
        match step {
            FakeHarnessStep::Delay { milliseconds } => {
                thread::sleep(Duration::from_millis(
                    delay_override_ms.unwrap_or(milliseconds),
                ));
            }
            FakeHarnessStep::Log { stream, text } => {
                output.send("log", json!({ "stream": stream, "text": text }))?;
            }
            FakeHarnessStep::Event {
                event_type,
                turn_id: step_turn_id,
                item_id,
                payload,
            } => {
                output.send_event(
                    &event_type,
                    step_turn_id.as_deref().or(Some(&turn_id)),
                    item_id.as_deref(),
                    payload,
                )?;
            }
            FakeHarnessStep::Request { request } => {
                output.send("request", json!({ "request": request }))?;
            }
            FakeHarnessStep::AwaitResolution { request_id } => {
                let command = receive_harness_command(
                    &command_receiver,
                    "request.resolve",
                    Some(&request_id),
                )?;
                output.send_event(
                    "runtime_request.resolved",
                    Some(&turn_id),
                    None,
                    json!({
                        "requestId": request_id,
                        "response": command.payload.get("response").cloned().unwrap_or(Value::Null)
                    }),
                )?;
            }
            FakeHarnessStep::AwaitInterrupt => {
                let command = receive_harness_command(&command_receiver, "turn.interrupt", None)?;
                output.send_event(
                    "turn.interrupted",
                    Some(&turn_id),
                    None,
                    json!({ "reason": command.payload.get("reason").cloned().unwrap_or_else(|| json!("operator")) }),
                )?;
            }
            FakeHarnessStep::Result { payload } => {
                output.send("result", json!({ "result": payload }))?;
            }
            FakeHarnessStep::Terminal { payload } => {
                output.send("terminal", json!({ "terminal": payload }))?;
            }
            FakeHarnessStep::SpawnWorker => {
                let worker = Command::new("sh")
                    .args(["-c", "sleep 60"])
                    .env_clear()
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|error| {
                        Phase2Error::invalid(format!("failed to spawn fake worker: {error}"))
                    })?;
                output.send(
                    "diagnostic",
                    json!({ "workerPid": worker.id(), "purpose": "cleanup_conformance" }),
                )?;
                workers.push(worker);
            }
            FakeHarnessStep::Exit { code } => {
                drop(workers);
                return Ok(code);
            }
        }
    }
    drop(workers);
    Ok(0)
}

fn receive_harness_command(
    receiver: &Receiver<HarnessCommand>,
    command_type: &str,
    request_id: Option<&str>,
) -> Result<HarnessCommand, Phase2Error> {
    loop {
        let command = receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| Phase2Error::invalid(format!("timed out waiting for {command_type}")))?;
        if command.schema != HARNESS_COMMAND_SCHEMA {
            continue;
        }
        if command.command_type != command_type {
            continue;
        }
        if let Some(request_id) = request_id {
            if command.payload.get("requestId").and_then(Value::as_str) != Some(request_id) {
                continue;
            }
        }
        return Ok(command);
    }
}

#[derive(Default)]
struct FakeHarnessOutput {
    sequence: u64,
}

impl FakeHarnessOutput {
    fn send(&mut self, message_type: &str, payload: Value) -> Result<(), Phase2Error> {
        self.sequence += 1;
        let message = json!({
            "schema": HARNESS_MESSAGE_SCHEMA,
            "messageSeq": self.sequence,
            "type": message_type,
            "payload": payload,
        });
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        serde_json::to_writer(&mut lock, &message).map_err(|error| {
            Phase2Error::invalid(format!("harness message serialization failed: {error}"))
        })?;
        lock.write_all(b"\n")
            .and_then(|_| lock.flush())
            .map_err(|error| Phase2Error::invalid(format!("harness message write failed: {error}")))
    }

    fn send_event(
        &mut self,
        event_type: &str,
        turn_id: Option<&str>,
        item_id: Option<&str>,
        payload: Value,
    ) -> Result<(), Phase2Error> {
        self.send(
            "event",
            json!({
                "eventType": event_type,
                "turnId": turn_id,
                "itemId": item_id,
                "payload": payload,
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_logs_keep_only_the_tail() {
        let mut logs = BoundedLogBuffer::new(2, 12);
        logs.push("first");
        logs.push("second");
        logs.push("third");

        assert_eq!(logs.snapshot().lines, vec!["second", "third"]);
        assert_eq!(logs.snapshot().dropped_lines, 1);
        assert!(logs.snapshot().retained_bytes <= 12);
    }

    #[test]
    fn canonical_json_sorts_object_keys_without_reordering_arrays() {
        assert_eq!(
            canonical_json(&json!({ "z": [2, 1], "a": { "b": true } })),
            r#"{"a":{"b":true},"z":[2,1]}"#
        );
    }

    #[test]
    fn all_phase2_scripts_load() {
        let scripts = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../protocol/fixtures/phase-02/scripts");
        for name in [
            "happy-path",
            "permission-input",
            "interrupted",
            "error",
            "duplicate-terminal",
            "linger",
        ] {
            let script = load_fake_harness_script(&scripts.join(format!("{name}.json")))
                .expect("Phase 2 script should load");
            assert_eq!(script.name, name);
        }
    }
}
