use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::phase2::SupervisedProcess;

const STATE_SCHEMA: &str = "paperclip.runner.phase3.state.v1";
const PROTOCOL: &str = "paperclip.runner";
const PROTOCOL_VERSION: u64 = 1;
const STATIC_WEBSOCKET_KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
const STATIC_WEBSOCKET_ACCEPT: &str = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const MAX_DIAGNOSTICS: usize = 32;
const REVOKE_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
const TEMP_FILE_ATTEMPTS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Phase3Error(String);

impl Phase3Error {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for Phase3Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for Phase3Error {}

struct SensitiveString(Vec<u8>);

impl SensitiveString {
    fn new(value: String) -> Self {
        Self(value.into_bytes())
    }

    fn expose(&self) -> &str {
        std::str::from_utf8(&self.0).expect("sensitive value started as valid UTF-8")
    }

    fn clear(&mut self) {
        self.0.fill(0);
        self.0.clear();
    }
}

impl Drop for SensitiveString {
    fn drop(&mut self) {
        self.clear();
    }
}

pub struct BootstrapTicket(SensitiveString);

impl BootstrapTicket {
    fn expose(&self) -> &str {
        self.0.expose()
    }
}

pub fn capture_bootstrap_ticket() -> Result<Option<BootstrapTicket>, Phase3Error> {
    let value = std::env::var_os("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
    std::env::remove_var("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET");
    value
        .map(|value| {
            value
                .into_string()
                .map(|value| BootstrapTicket(SensitiveString::new(value)))
                .map_err(|_| Phase3Error::invalid("runner bootstrap ticket is not valid UTF-8"))
        })
        .transpose()
}

#[derive(Clone, Debug)]
pub struct DurableRunnerConfig {
    pub connect_url: String,
    pub state_dir: PathBuf,
    pub runner_instance_id: String,
    pub environment_lease_id: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub runner_version: String,
    pub runner_digest: String,
    pub fake_harness_path: Option<PathBuf>,
    pub fake_harness_script_path: Option<PathBuf>,
    pub max_outbox_bytes: usize,
    pub p0_reserve_bytes: usize,
    pub max_frame_bytes: usize,
    pub reconnect_delay: Duration,
    pub max_runtime: Duration,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredOutboxEvent {
    pub source_seq: u64,
    pub source_event_id: String,
    pub priority: u8,
    pub event_type: String,
    pub item_id: Option<String>,
    pub envelope: Value,
    pub byte_size: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessedCommand {
    pub command_id: String,
    pub controller_seq: u64,
    pub command_digest: String,
    pub status: String,
    pub logical_effect_count: u64,
    pub result: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableRunnerState {
    pub schema: String,
    pub runner_instance_id: String,
    pub environment_lease_id: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub lifecycle: String,
    pub next_source_seq: u64,
    pub acked_source_seq: u64,
    pub last_controller_command_seq: u64,
    pub reconnect_count: u64,
    pub max_outbox_bytes: usize,
    pub peak_outbox_bytes: usize,
    pub outbox: Vec<StoredOutboxEvent>,
    pub processed_commands: BTreeMap<String, ProcessedCommand>,
    pub diagnostics: Vec<String>,
    pub backpressure: bool,
    pub recoverable_failure: Option<String>,
    pub unrecoverable_outcome: Option<String>,
    pub harness_generation: u64,
    pub stop_after_flush: bool,
}

impl DurableRunnerState {
    fn new(config: &DurableRunnerConfig) -> Self {
        Self {
            schema: STATE_SCHEMA.to_owned(),
            runner_instance_id: config.runner_instance_id.clone(),
            environment_lease_id: config.environment_lease_id.clone(),
            run_id: config.run_id.clone(),
            normalized_session_id: config.normalized_session_id.clone(),
            turn_id: config.turn_id.clone(),
            item_id: config.item_id.clone(),
            lifecycle: "connecting".to_owned(),
            next_source_seq: 1,
            acked_source_seq: 0,
            last_controller_command_seq: 0,
            reconnect_count: 0,
            max_outbox_bytes: config.max_outbox_bytes,
            peak_outbox_bytes: 0,
            outbox: Vec::new(),
            processed_commands: BTreeMap::new(),
            diagnostics: Vec::new(),
            backpressure: false,
            recoverable_failure: None,
            unrecoverable_outcome: None,
            harness_generation: 1,
            stop_after_flush: false,
        }
    }

    pub fn outbox_bytes(&self) -> usize {
        self.outbox.iter().map(|event| event.byte_size).sum()
    }

    pub fn highest_source_seq(&self) -> u64 {
        self.next_source_seq.saturating_sub(1)
    }

    pub fn apply_ack(&mut self, acked_source_seq: u64) -> Result<(), Phase3Error> {
        if acked_source_seq < self.acked_source_seq {
            return Err(Phase3Error::invalid(
                "cumulative ACK cannot move behind the durable cursor",
            ));
        }
        if acked_source_seq > self.highest_source_seq() {
            return Err(Phase3Error::invalid(
                "cumulative ACK cannot move beyond the produced source cursor",
            ));
        }
        self.acked_source_seq = acked_source_seq;
        self.outbox
            .retain(|event| event.source_seq > acked_source_seq);
        Ok(())
    }

    fn record_diagnostic(&mut self, message: impl Into<String>) {
        self.diagnostics.push(redact_text(&message.into()));
        if self.diagnostics.len() > MAX_DIAGNOSTICS {
            self.diagnostics.remove(0);
        }
    }
}

#[derive(Clone, Debug)]
pub struct DurableStateStore {
    path: PathBuf,
}

impl DurableStateStore {
    pub fn new(state_dir: &Path) -> Result<Self, Phase3Error> {
        if let Ok(metadata) = fs::symlink_metadata(state_dir) {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err(Phase3Error::invalid(format!(
                    "runner state directory {} must be a real directory",
                    state_dir.display()
                )));
            }
        }
        fs::create_dir_all(state_dir).map_err(|error| {
            Phase3Error::invalid(format!(
                "failed to create runner state directory {}: {error}",
                state_dir.display()
            ))
        })?;
        #[cfg(unix)]
        fs::set_permissions(state_dir, fs::Permissions::from_mode(0o700)).map_err(|error| {
            Phase3Error::invalid(format!(
                "failed to secure runner state directory {}: {error}",
                state_dir.display()
            ))
        })?;
        verify_private_directory(state_dir)?;
        Ok(Self {
            path: state_dir.join("runner-state.json"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load_or_create(
        &self,
        config: &DurableRunnerConfig,
    ) -> Result<(DurableRunnerState, bool), Phase3Error> {
        let bytes = match open_private_regular_file(&self.path) {
            Ok(mut file) => {
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).map_err(|error| {
                    Phase3Error::invalid(format!(
                        "failed to read durable runner state {}: {error}",
                        self.path.display()
                    ))
                })?;
                bytes
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let state = DurableRunnerState::new(config);
                self.save(&state)?;
                return Ok((state, false));
            }
            Err(error) => {
                return Err(Phase3Error::invalid(format!(
                    "failed to open private durable runner state {}: {error}",
                    self.path.display()
                )))
            }
        };
        let state: DurableRunnerState = serde_json::from_slice(&bytes).map_err(|error| {
            Phase3Error::invalid(format!(
                "durable runner state is malformed and cannot be recovered: {error}"
            ))
        })?;
        validate_state_binding(&state, config)?;
        Ok((state, true))
    }

    pub fn save(&self, state: &DurableRunnerState) -> Result<(), Phase3Error> {
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| {
            Phase3Error::invalid(format!("failed to serialize durable runner state: {error}"))
        })?;
        let (temporary, mut file) = create_private_temporary_file(&self.path)?;
        let result = (|| -> Result<(), Phase3Error> {
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    Phase3Error::invalid(format!("failed to commit durable runner state: {error}"))
                })?;
            drop(file);
            fs::rename(&temporary, &self.path).map_err(|error| {
                Phase3Error::invalid(format!("failed to replace durable runner state: {error}"))
            })?;
            sync_parent_directory(&self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn effective_user_id() -> io::Result<u32> {
    Ok(fs::metadata("/proc/self")?.uid())
}

fn verify_private_directory(path: &Path) -> Result<(), Phase3Error> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        Phase3Error::invalid(format!(
            "failed to inspect runner state directory {}: {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(Phase3Error::invalid(
            "runner state directory must be a real directory",
        ));
    }
    #[cfg(unix)]
    {
        if metadata.mode() & 0o777 != 0o700 {
            return Err(Phase3Error::invalid(
                "runner state directory permissions must be 0700",
            ));
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if metadata.uid()
            != effective_user_id().map_err(|error| {
                Phase3Error::invalid(format!("failed to inspect daemon ownership: {error}"))
            })?
        {
            return Err(Phase3Error::invalid(
                "runner state directory must be owned by the daemon user",
            ));
        }
    }
    Ok(())
}

fn open_private_regular_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(no_follow_flag());
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "state path is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        if metadata.mode() & 0o777 != 0o600 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "state file permissions must be 0600",
            ));
        }
        #[cfg(any(target_os = "linux", target_os = "android"))]
        if metadata.uid() != effective_user_id()? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "state file must be owned by the daemon user",
            ));
        }
    }
    Ok(file)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
const fn no_follow_flag() -> i32 {
    0x20000
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
const fn no_follow_flag() -> i32 {
    0x100
}

fn random_suffix() -> Result<String, Phase3Error> {
    let mut bytes = [0_u8; 16];
    #[cfg(unix)]
    {
        File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .map_err(|error| {
                Phase3Error::invalid(format!("failed to obtain state-file randomness: {error}"))
            })?;
    }
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "bcrypt")]
        unsafe extern "system" {
            fn BCryptGenRandom(
                algorithm: *mut c_void,
                buffer: *mut u8,
                buffer_length: u32,
                flags: u32,
            ) -> i32;
        }
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
        // SAFETY: the system RNG receives a valid writable buffer for its exact length.
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status < 0 {
            return Err(Phase3Error::invalid(
                "failed to obtain state-file randomness from BCryptGenRandom",
            ));
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        return Err(Phase3Error::invalid(
            "secure state-file randomness is unsupported on this platform",
        ));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn create_private_temporary_file(destination: &Path) -> Result<(PathBuf, File), Phase3Error> {
    let parent = destination
        .parent()
        .ok_or_else(|| Phase3Error::invalid("durable state path has no parent directory"))?;
    let filename = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| Phase3Error::invalid("durable state filename is not valid UTF-8"))?;
    for _ in 0..TEMP_FILE_ATTEMPTS {
        let path = parent.join(format!(".{filename}.{}.tmp", random_suffix()?));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(no_follow_flag());
        match options.open(&path) {
            Ok(file) => {
                #[cfg(unix)]
                if let Err(error) = file.set_permissions(fs::Permissions::from_mode(0o600)) {
                    let _ = fs::remove_file(&path);
                    return Err(Phase3Error::invalid(format!(
                        "failed to secure temporary runner state: {error}"
                    )));
                }
                let metadata = file.metadata().map_err(|error| {
                    Phase3Error::invalid(format!(
                        "failed to inspect temporary runner state: {error}"
                    ))
                })?;
                if !metadata.file_type().is_file() {
                    let _ = fs::remove_file(&path);
                    return Err(Phase3Error::invalid(
                        "temporary runner state is not a regular file",
                    ));
                }
                #[cfg(unix)]
                {
                    if metadata.mode() & 0o777 != 0o600 {
                        let _ = fs::remove_file(&path);
                        return Err(Phase3Error::invalid(
                            "temporary runner state is not private",
                        ));
                    }
                    #[cfg(any(target_os = "linux", target_os = "android"))]
                    if metadata.uid()
                        != effective_user_id().map_err(|error| {
                            Phase3Error::invalid(format!(
                                "failed to inspect temporary state ownership: {error}"
                            ))
                        })?
                    {
                        let _ = fs::remove_file(&path);
                        return Err(Phase3Error::invalid(
                            "temporary runner state is not daemon-owned",
                        ));
                    }
                }
                return Ok((path, file));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(Phase3Error::invalid(format!(
                    "failed to create exclusive temporary runner state: {error}"
                )))
            }
        }
    }
    Err(Phase3Error::invalid(
        "failed to allocate a unique temporary runner state file",
    ))
}

fn sync_parent_directory(path: &Path) -> Result<(), Phase3Error> {
    #[cfg(unix)]
    {
        let parent = path
            .parent()
            .ok_or_else(|| Phase3Error::invalid("durable state path has no parent directory"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                Phase3Error::invalid(format!(
                    "failed to sync durable state parent directory: {error}"
                ))
            })?;
    }
    Ok(())
}

fn validate_state_binding(
    state: &DurableRunnerState,
    config: &DurableRunnerConfig,
) -> Result<(), Phase3Error> {
    if state.schema != STATE_SCHEMA {
        return Err(Phase3Error::invalid(
            "unsupported durable runner state schema",
        ));
    }
    for (name, stored, expected) in [
        (
            "runnerInstanceId",
            state.runner_instance_id.as_str(),
            config.runner_instance_id.as_str(),
        ),
        (
            "environmentLeaseId",
            state.environment_lease_id.as_str(),
            config.environment_lease_id.as_str(),
        ),
        ("runId", state.run_id.as_str(), config.run_id.as_str()),
        (
            "normalizedSessionId",
            state.normalized_session_id.as_str(),
            config.normalized_session_id.as_str(),
        ),
        ("turnId", state.turn_id.as_str(), config.turn_id.as_str()),
        ("itemId", state.item_id.as_str(), config.item_id.as_str()),
    ] {
        if stored != expected {
            return Err(Phase3Error::invalid(format!(
                "durable {name} does not match the requested recovery identity"
            )));
        }
    }
    Ok(())
}

fn redaction_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase().replace('-', "_");
    [
        "authorization",
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "credential",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

pub fn redact_text(input: &str) -> String {
    if input.to_ascii_lowercase().contains("bearer ") {
        return "[REDACTED]".to_owned();
    }
    input.to_owned()
}

pub fn sanitize_value(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if redaction_key(key) {
                            Value::String("[REDACTED]".to_owned())
                        } else {
                            sanitize_value(value)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(sanitize_value).collect()),
        Value::String(text) => Value::String(redact_text(text)),
        other => other.clone(),
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let body = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key serialization cannot fail"),
                        canonical_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        scalar => serde_json::to_string(scalar).expect("JSON scalar serialization cannot fail"),
    }
}

fn fnv1a_digest(input: &[u8]) -> String {
    let mut digest = 0xcbf29ce484222325_u64;
    for byte in input {
        digest ^= u64::from(*byte);
        digest = digest.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{digest:016x}")
}

fn deterministic_time(sequence: u64) -> String {
    format!(
        "2026-08-07T23:{:02}:{:02}.{:03}Z",
        (sequence / 60_000) % 60,
        (sequence / 1_000) % 60,
        sequence % 1_000
    )
}

fn event_envelope(
    state: &DurableRunnerState,
    source_seq: u64,
    event_type: &str,
    priority: u8,
    payload: Value,
    item_id: Option<&str>,
) -> Value {
    let source_event_id = format!("event_{}_{source_seq:06}", state.runner_instance_id);
    let mut event = json!({
        "schema": "paperclip.prp.event.v1",
        "sourceEventId": source_event_id,
        "sourceSeq": source_seq,
        "sourceInstanceId": state.runner_instance_id,
        "sourceKind": "runner",
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "turnId": state.turn_id,
        "eventType": event_type,
        "schemaVersion": 1,
        "priority": priority,
        "emittedAt": deterministic_time(source_seq),
        "payload": sanitize_value(&payload),
    });
    if let Some(item_id) = item_id {
        event["itemId"] = Value::String(item_id.to_owned());
    }
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "envelopeId": format!("envelope_event_{source_seq:06}"),
        "kind": "event",
        "runnerInstanceId": state.runner_instance_id,
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "turnId": state.turn_id,
        "sentAt": deterministic_time(source_seq),
        "payload": event,
    })
}

fn mark_backpressure(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
) -> Result<(), Phase3Error> {
    if state.backpressure {
        return Ok(());
    }
    state.backpressure = true;
    state.lifecycle = "backpressure".to_owned();
    enqueue_event(
        state,
        config,
        "runner.backpressure",
        0,
        json!({
            "reason": "outbox_soft_limit",
            "maxOutboxBytes": config.max_outbox_bytes,
            "p0ReserveBytes": config.p0_reserve_bytes,
            "newTurnsAccepted": false,
        }),
        None,
    )
}

fn enqueue_event(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
    event_type: &str,
    priority: u8,
    payload: Value,
    item_id: Option<&str>,
) -> Result<(), Phase3Error> {
    if priority > 2 {
        return Err(Phase3Error::invalid("event priority must be P0, P1, or P2"));
    }

    if priority == 2 {
        if let Some(last) = state.outbox.last_mut() {
            if last.priority == 2
                && last.event_type == event_type
                && last.item_id.as_deref() == item_id
            {
                let previous_count = last
                    .envelope
                    .pointer("/payload/payload/coalescedCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(1);
                let compacted = json!({
                    "coalescedCount": previous_count + 1,
                    "latest": sanitize_value(&payload),
                });
                last.envelope["payload"]["payload"] = compacted;
                last.byte_size = serde_json::to_vec(&last.envelope)
                    .map_err(|error| Phase3Error::invalid(error.to_string()))?
                    .len();
                state.peak_outbox_bytes = state.peak_outbox_bytes.max(state.outbox_bytes());
                if state.outbox_bytes()
                    > config
                        .max_outbox_bytes
                        .saturating_sub(config.p0_reserve_bytes)
                {
                    return mark_backpressure(state, config);
                }
                return Ok(());
            }
        }
    }

    let source_seq = state.next_source_seq;
    let envelope = event_envelope(state, source_seq, event_type, priority, payload, item_id);
    let bytes =
        serde_json::to_vec(&envelope).map_err(|error| Phase3Error::invalid(error.to_string()))?;
    let byte_size = bytes.len();
    let projected = state.outbox_bytes().saturating_add(byte_size);
    let non_p0_limit = config
        .max_outbox_bytes
        .saturating_sub(config.p0_reserve_bytes);

    if priority == 2 && projected > non_p0_limit {
        return mark_backpressure(state, config);
    }
    if priority == 1 && projected > non_p0_limit {
        mark_backpressure(state, config)?;
        return Err(Phase3Error::invalid(
            "P1 event cannot enter the reserved P0 storage region",
        ));
    }
    if projected > config.max_outbox_bytes {
        state.lifecycle = "unrecoverable".to_owned();
        state.unrecoverable_outcome = Some("p0_storage_exhausted".to_owned());
        state.record_diagnostic(
            "P0 storage reserve is exhausted; the durable session requires operator recovery",
        );
        return Err(Phase3Error::invalid(
            "P0 storage reserve exhausted; durable recovery is explicit",
        ));
    }

    state.next_source_seq += 1;
    state.outbox.push(StoredOutboxEvent {
        source_seq,
        source_event_id: format!("event_{}_{source_seq:06}", state.runner_instance_id),
        priority,
        event_type: event_type.to_owned(),
        item_id: item_id.map(str::to_owned),
        envelope,
        byte_size,
    });
    state.peak_outbox_bytes = state.peak_outbox_bytes.max(state.outbox_bytes());
    Ok(())
}

fn command_result_envelope(state: &DurableRunnerState, processed: &ProcessedCommand) -> Value {
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "envelopeId": format!("envelope_result_{}", processed.command_id),
        "kind": "command_result",
        "runnerInstanceId": state.runner_instance_id,
        "runId": state.run_id,
        "normalizedSessionId": state.normalized_session_id,
        "sentAt": deterministic_time(processed.controller_seq),
        "payload": processed.result,
    })
}

fn execute_command_effect(
    state: &mut DurableRunnerState,
    config: &DurableRunnerConfig,
    command_type: &str,
    payload: &Value,
) -> Result<(String, u64, String), Phase3Error> {
    if state.lifecycle == "revoked" {
        return Ok((
            "rejected".to_owned(),
            0,
            "connection capability is revoked; commands have no logical effect".to_owned(),
        ));
    }
    match command_type {
        "run.prepare" => {
            state.lifecycle = "ready".to_owned();
            enqueue_event(
                state,
                config,
                "workspace.ready",
                1,
                json!({ "workspace": "phase-03-durable-fixture" }),
                None,
            )?;
            Ok(("completed".to_owned(), 1, "run prepared".to_owned()))
        }
        "session.open" => {
            enqueue_event(
                state,
                config,
                "session.started",
                0,
                json!({
                    "normalizedSessionId": state.normalized_session_id,
                    "driverSessionId": "driver_phase3_fake",
                    "resumed": state.reconnect_count > 0,
                }),
                None,
            )?;
            Ok(("completed".to_owned(), 1, "session bound".to_owned()))
        }
        "fault.harness_restart" => {
            prove_harness_restart(config)?;
            let previous_generation = state.harness_generation;
            state.harness_generation += 1;
            enqueue_event(
                state,
                config,
                "harness.exited",
                0,
                json!({
                    "generation": previous_generation,
                    "reason": "fault_injection_restart",
                    "recoverable": true,
                }),
                None,
            )?;
            enqueue_event(
                state,
                config,
                "harness.ready",
                0,
                json!({
                    "generation": state.harness_generation,
                    "driverKind": "fake",
                }),
                None,
            )?;
            enqueue_event(
                state,
                config,
                "session.reconciled",
                0,
                json!({
                    "normalizedSessionId": state.normalized_session_id,
                    "turnId": state.turn_id,
                    "itemId": state.item_id,
                    "outcome": "same_session_resumed",
                }),
                Some(&state.item_id.clone()),
            )?;
            Ok((
                "completed".to_owned(),
                1,
                "harness restarted and reconciled".to_owned(),
            ))
        }
        "fault.storage_pressure" => {
            let item_id = state.item_id.clone();
            for index in 0..250_u64 {
                enqueue_event(
                    state,
                    config,
                    "item.delta",
                    2,
                    json!({
                        "chunk": format!("bounded-progress-{index:03}"),
                        "secretToken": "must-not-persist",
                    }),
                    Some(&item_id),
                )?;
            }
            mark_backpressure(state, config)?;
            Ok((
                "completed".to_owned(),
                1,
                "storage pressure applied with P2 coalescing".to_owned(),
            ))
        }
        "turn.start" if state.lifecycle == "draining" || state.backpressure => Ok((
            "rejected".to_owned(),
            0,
            "new turns are disabled while draining or backpressured".to_owned(),
        )),
        "turn.start" => {
            let item_id = state.item_id.clone();
            enqueue_event(
                state,
                config,
                "turn.accepted",
                0,
                json!({ "turnId": state.turn_id, "sameSession": true }),
                None,
            )?;
            enqueue_event(
                state,
                config,
                "item.started",
                1,
                json!({ "kind": "assistant_message" }),
                Some(&item_id),
            )?;
            enqueue_event(
                state,
                config,
                "item.delta",
                2,
                json!({ "text": payload.get("text").cloned().unwrap_or_else(|| json!("Phase 3")) }),
                Some(&item_id),
            )?;
            enqueue_event(
                state,
                config,
                "item.completed",
                1,
                json!({ "text": "Durable recovery completed." }),
                Some(&item_id),
            )?;
            enqueue_event(
                state,
                config,
                "run.result.proposed",
                0,
                json!({
                    "schema": "paperclip.prp.result.v1",
                    "status": "succeeded",
                    "reportedWorkDisposition": "done",
                    "summary": "Phase 3 durable transport recovered without duplicate effects.",
                }),
                None,
            )?;
            enqueue_event(
                state,
                config,
                "run.terminal",
                0,
                json!({
                    "schema": "paperclip.prp.terminal.v1",
                    "turnTerminalState": "completed",
                    "runTerminalState": "succeeded",
                    "reportedWorkDisposition": "done",
                }),
                None,
            )?;
            state.lifecycle = "terminal".to_owned();
            Ok(("completed".to_owned(), 1, "turn completed".to_owned()))
        }
        "runner.drain" => {
            state.lifecycle = "draining".to_owned();
            enqueue_event(
                state,
                config,
                "runner.draining",
                0,
                json!({ "newWorkAccepted": false }),
                None,
            )?;
            Ok(("completed".to_owned(), 1, "runner draining".to_owned()))
        }
        "runner.shutdown" => {
            state.stop_after_flush = true;
            enqueue_event(
                state,
                config,
                "runner.stopped",
                0,
                json!({ "afterDurableFlush": true }),
                None,
            )?;
            Ok((
                "completed".to_owned(),
                1,
                "runner will stop after durable flush".to_owned(),
            ))
        }
        unsupported => Ok((
            "rejected".to_owned(),
            0,
            format!("unsupported Phase 3 command: {unsupported}"),
        )),
    }
}

fn prove_harness_restart(config: &DurableRunnerConfig) -> Result<(), Phase3Error> {
    let fake_harness_path = config.fake_harness_path.as_ref().ok_or_else(|| {
        Phase3Error::invalid("fake harness path is required for restart injection")
    })?;
    let script_path = config.fake_harness_script_path.as_ref().ok_or_else(|| {
        Phase3Error::invalid("fake harness script is required for restart injection")
    })?;
    let args = vec![
        "--script".to_owned(),
        script_path.display().to_string(),
        "--delay-ms".to_owned(),
        "1".to_owned(),
    ];
    for generation in 1..=2_u64 {
        let mut harness = SupervisedProcess::spawn(
            fake_harness_path,
            &args,
            Duration::from_millis(50),
            64 * 1024,
        )
        .map_err(|error| {
            Phase3Error::invalid(format!(
                "failed to start fake harness generation {generation}: {error}"
            ))
        })?;
        let ready = harness
            .receive_stdout_line(Duration::from_secs(2))
            .map_err(|error| Phase3Error::invalid(error.to_string()))?
            .ok_or_else(|| {
                Phase3Error::invalid(format!(
                    "fake harness generation {generation} did not become ready"
                ))
            })?;
        let message: Value = serde_json::from_str(&ready).map_err(|error| {
            Phase3Error::invalid(format!(
                "fake harness generation {generation} emitted malformed ready data: {error}"
            ))
        })?;
        if message.get("type").and_then(Value::as_str) != Some("ready") {
            return Err(Phase3Error::invalid(format!(
                "fake harness generation {generation} did not emit a ready message"
            )));
        }
        harness
            .terminate_group()
            .map_err(|error| Phase3Error::invalid(error.to_string()))?;
    }
    Ok(())
}

fn process_command(
    state: &mut DurableRunnerState,
    store: &DurableStateStore,
    config: &DurableRunnerConfig,
    command: &Value,
) -> Result<ProcessedCommand, Phase3Error> {
    let command_id = command
        .get("commandId")
        .and_then(Value::as_str)
        .ok_or_else(|| Phase3Error::invalid("commandId is required"))?;
    let controller_seq = command
        .get("controllerSeq")
        .and_then(Value::as_u64)
        .ok_or_else(|| Phase3Error::invalid("controllerSeq is required"))?;
    let command_type = command
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| Phase3Error::invalid("command type is required"))?;
    let canonical = canonical_json(command);
    let command_digest = fnv1a_digest(canonical.as_bytes());

    if let Some(previous) = state.processed_commands.get(command_id) {
        if previous.command_digest != command_digest {
            return Err(Phase3Error::invalid(
                "commandId was reused with a different payload",
            ));
        }
        return Ok(previous.clone());
    }
    if controller_seq != state.last_controller_command_seq + 1 {
        return Err(Phase3Error::invalid(format!(
            "controllerSeq must be {}; received {controller_seq}",
            state.last_controller_command_seq + 1
        )));
    }

    let payload = command.get("payload").cloned().unwrap_or(Value::Null);
    let effect = execute_command_effect(state, config, command_type, &payload);
    let (status, logical_effect_count, detail) = match effect {
        Ok(effect) => effect,
        Err(error) if state.unrecoverable_outcome.is_some() => {
            ("failed".to_owned(), 1, error.to_string())
        }
        Err(error) => return Err(error),
    };
    let result = sanitize_value(&json!({
        "commandId": command_id,
        "controllerSeq": controller_seq,
        "status": status,
        "logicalEffectCount": logical_effect_count,
        "detail": detail,
    }));
    let processed = ProcessedCommand {
        command_id: command_id.to_owned(),
        controller_seq,
        command_digest,
        status,
        logical_effect_count,
        result,
    };
    state.last_controller_command_seq = controller_seq;
    state
        .processed_commands
        .insert(command_id.to_owned(), processed.clone());
    store.save(state)?;
    Ok(processed)
}

struct ParsedWsUrl {
    host: String,
    authority: String,
    port: u16,
    path: String,
}

fn parse_ws_url(input: &str) -> Result<ParsedWsUrl, Phase3Error> {
    let remainder = input
        .strip_prefix("ws://")
        .ok_or_else(|| Phase3Error::invalid("runner core accepts exactly the ws:// scheme"))?;
    if remainder.is_empty()
        || remainder
            .chars()
            .any(|character| character.is_ascii_control() || character.is_ascii_whitespace())
        || remainder.contains(['?', '#', '\\'])
    {
        return Err(Phase3Error::invalid(
            "WebSocket URL contains malformed, query, fragment, or path ambiguity",
        ));
    }
    let (authority, path) = remainder
        .split_once('/')
        .map_or((remainder, "/".to_owned()), |(authority, path)| {
            (authority, format!("/{path}"))
        });
    if authority.is_empty() || authority.contains(['@', '%']) {
        return Err(Phase3Error::invalid(
            "WebSocket authority must not contain userinfo or encoding ambiguity",
        ));
    }
    let (host, port) = if authority.starts_with('[') {
        let closing = authority
            .find(']')
            .ok_or_else(|| Phase3Error::invalid("bracketed IPv6 authority is malformed"))?;
        let host = &authority[1..closing];
        let port = authority[closing + 1..]
            .strip_prefix(':')
            .ok_or_else(|| Phase3Error::invalid("bracketed IPv6 authority requires a port"))?;
        host.parse::<std::net::Ipv6Addr>()
            .map_err(|_| Phase3Error::invalid("bracketed WebSocket host must be IPv6"))?;
        (host, port)
    } else {
        let (host, port) = authority
            .rsplit_once(':')
            .ok_or_else(|| Phase3Error::invalid("WebSocket URL must include an explicit port"))?;
        if host.is_empty() || host.contains(':') {
            return Err(Phase3Error::invalid(
                "WebSocket host is empty or an unbracketed IPv6 literal",
            ));
        }
        (host, port)
    };
    let port = port
        .parse::<u16>()
        .map_err(|error| Phase3Error::invalid(format!("invalid WebSocket port: {error}")))?;
    if port == 0 {
        return Err(Phase3Error::invalid("WebSocket port must be non-zero"));
    }
    Ok(ParsedWsUrl {
        host: host.to_owned(),
        authority: authority.to_owned(),
        port,
        path,
    })
}

struct ResolvedWsTarget {
    authority: String,
    path: String,
    addresses: Vec<SocketAddr>,
}

impl ResolvedWsTarget {
    fn resolve(input: &str) -> Result<Self, Phase3Error> {
        resolve_ws_target_with(input, |host, port| {
            (host, port)
                .to_socket_addrs()
                .map(|addresses| addresses.collect())
        })
    }
}

fn resolve_ws_target_with<F>(input: &str, resolver: F) -> Result<ResolvedWsTarget, Phase3Error>
where
    F: FnOnce(&str, u16) -> io::Result<Vec<SocketAddr>>,
{
    let parsed = parse_ws_url(input)?;
    let mut addresses = resolver(&parsed.host, parsed.port).map_err(|error| {
        Phase3Error::invalid(format!("failed to resolve WebSocket destination: {error}"))
    })?;
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(Phase3Error::invalid(
            "WebSocket destination resolved to no addresses",
        ));
    }
    if addresses.iter().any(|address| !address.ip().is_loopback()) {
        return Err(Phase3Error::invalid(
            "every WebSocket destination must be loopback (127.0.0.0/8 or ::1)",
        ));
    }
    Ok(ResolvedWsTarget {
        authority: parsed.authority,
        path: parsed.path,
        addresses,
    })
}

struct WsClient {
    stream: TcpStream,
    mask_counter: u32,
    max_frame_bytes: usize,
}

fn encode_masked_frame(
    opcode: u8,
    payload: &[u8],
    mask: [u8; 4],
    max_frame_bytes: usize,
) -> Result<Vec<u8>, Phase3Error> {
    if payload.len() > max_frame_bytes {
        return Err(Phase3Error::invalid(
            "outbound WebSocket frame exceeds the limit",
        ));
    }
    let mut frame = vec![0x80 | opcode];
    match payload.len() {
        length if length <= 125 => frame.push(0x80 | length as u8),
        length if length <= u16::MAX as usize => {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    Ok(frame)
}

fn checked_inbound_frame_length(length: u64, max_frame_bytes: usize) -> Result<usize, Phase3Error> {
    let length = usize::try_from(length)
        .map_err(|_| Phase3Error::invalid("WebSocket frame length overflow"))?;
    if length > max_frame_bytes {
        return Err(Phase3Error::invalid(
            "inbound WebSocket frame exceeds the limit",
        ));
    }
    Ok(length)
}

impl WsClient {
    fn connect(
        target: &ResolvedWsTarget,
        authorization: &str,
        max_frame_bytes: usize,
    ) -> Result<Self, Phase3Error> {
        let mut stream = TcpStream::connect(target.addresses.as_slice())
            .map_err(|error| Phase3Error::invalid(format!("WebSocket connect failed: {error}")))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| Phase3Error::invalid(error.to_string()))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| Phase3Error::invalid(error.to_string()))?;
        let mut request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer {}\r\n\r\n",
            target.path,
            target.authority,
            STATIC_WEBSOCKET_KEY,
            authorization
        )
        .into_bytes();
        let write_result = stream.write_all(&request).and_then(|_| stream.flush());
        // The HTTP upgrade request contains the bearer capability. Overwrite it before
        // propagating success or failure so it does not linger in daemon memory.
        request.fill(0);
        request.clear();
        write_result.map_err(|error| {
            Phase3Error::invalid(format!("WebSocket upgrade write failed: {error}"))
        })?;

        let mut response = Vec::new();
        let mut byte = [0_u8; 1];
        while !response.ends_with(b"\r\n\r\n") {
            if response.len() >= MAX_HTTP_HEADER_BYTES {
                return Err(Phase3Error::invalid(
                    "WebSocket response headers are too large",
                ));
            }
            stream.read_exact(&mut byte).map_err(|error| {
                Phase3Error::invalid(format!("WebSocket upgrade response failed: {error}"))
            })?;
            response.push(byte[0]);
        }
        let response = String::from_utf8(response)
            .map_err(|error| Phase3Error::invalid(format!("invalid HTTP response: {error}")))?;
        if !response.starts_with("HTTP/1.1 101 ") {
            let status = response
                .lines()
                .next()
                .unwrap_or("HTTP response unavailable");
            return Err(Phase3Error::invalid(format!(
                "WebSocket authentication or upgrade rejected: {status}"
            )));
        }
        let accept_valid = response.lines().any(|line| {
            line.split_once(':').is_some_and(|(name, value)| {
                name.eq_ignore_ascii_case("sec-websocket-accept")
                    && value.trim() == STATIC_WEBSOCKET_ACCEPT
            })
        });
        if !accept_valid {
            return Err(Phase3Error::invalid(
                "WebSocket server returned an invalid acceptance proof",
            ));
        }
        stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|error| Phase3Error::invalid(error.to_string()))?;
        Ok(Self {
            stream,
            mask_counter: 1,
            max_frame_bytes,
        })
    }

    fn send_json(&mut self, value: &Value) -> Result<(), Phase3Error> {
        let bytes = serde_json::to_vec(value).map_err(|error| {
            Phase3Error::invalid(format!("frame serialization failed: {error}"))
        })?;
        self.send_frame(0x1, &bytes)
    }

    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), Phase3Error> {
        let mask = self.mask_counter.to_be_bytes();
        self.mask_counter = self.mask_counter.wrapping_add(1);
        let frame = encode_masked_frame(opcode, payload, mask, self.max_frame_bytes)?;
        self.stream
            .write_all(&frame)
            .and_then(|_| self.stream.flush())
            .map_err(|error| Phase3Error::invalid(format!("WebSocket frame write failed: {error}")))
    }

    fn receive_json(&mut self) -> Result<Option<Value>, Phase3Error> {
        loop {
            let mut header = [0_u8; 2];
            match self.stream.read_exact(&mut header) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None);
                }
                Err(error) => {
                    return Err(Phase3Error::invalid(format!(
                        "WebSocket connection closed: {error}"
                    )))
                }
            }
            let opcode = header[0] & 0x0f;
            let masked = header[1] & 0x80 != 0;
            let mut length = u64::from(header[1] & 0x7f);
            if length == 126 {
                let mut extended = [0_u8; 2];
                self.stream
                    .read_exact(&mut extended)
                    .map_err(|error| Phase3Error::invalid(error.to_string()))?;
                length = u64::from(u16::from_be_bytes(extended));
            } else if length == 127 {
                let mut extended = [0_u8; 8];
                self.stream
                    .read_exact(&mut extended)
                    .map_err(|error| Phase3Error::invalid(error.to_string()))?;
                length = u64::from_be_bytes(extended);
            }
            let length = checked_inbound_frame_length(length, self.max_frame_bytes)?;
            let mut mask = [0_u8; 4];
            if masked {
                self.stream
                    .read_exact(&mut mask)
                    .map_err(|error| Phase3Error::invalid(error.to_string()))?;
            }
            let mut payload = vec![0_u8; length];
            self.stream
                .read_exact(&mut payload)
                .map_err(|error| Phase3Error::invalid(error.to_string()))?;
            if masked {
                for (index, byte) in payload.iter_mut().enumerate() {
                    *byte ^= mask[index % 4];
                }
            }
            match opcode {
                0x1 => {
                    let value = serde_json::from_slice(&payload).map_err(|error| {
                        Phase3Error::invalid(format!("malformed WebSocket JSON: {error}"))
                    })?;
                    return Ok(Some(value));
                }
                0x8 => return Err(Phase3Error::invalid("WebSocket peer closed the connection")),
                0x9 => self.send_frame(0xA, &payload)?,
                0xA => {}
                _ => return Err(Phase3Error::invalid("unsupported WebSocket frame opcode")),
            }
        }
    }
}

fn hello_envelope(state: &DurableRunnerState, config: &DurableRunnerConfig) -> Value {
    let unacked_range = state
        .outbox
        .first()
        .zip(state.outbox.last())
        .map(|(first, last)| json!([first.source_seq, last.source_seq]));
    json!({
        "protocol": PROTOCOL,
        "version": PROTOCOL_VERSION,
        "envelopeId": format!("envelope_hello_{}", state.reconnect_count),
        "kind": "hello",
        "runnerInstanceId": state.runner_instance_id,
        "sentAt": deterministic_time(state.reconnect_count),
        "payload": {
            "protocolMin": 1,
            "protocolMax": 1,
            "runnerVersion": config.runner_version,
            "runnerDigest": config.runner_digest,
            "environmentLeaseId": state.environment_lease_id,
            "sandboxProvider": "standalone_mock",
            "platform": {
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "hostname": "redacted-standalone-runner",
            },
            "drivers": [{
                "kind": "fake",
                "version": "1.0.0",
                "capabilities": { "resume": true, "interrupt": true },
            }],
            "resume": {
                "lastControllerCommandSeq": state.last_controller_command_seq,
                "nextSourceEventSeq": state.next_source_seq,
                "ackedSourceSeq": state.acked_source_seq,
                "unackedEventRange": unacked_range,
            },
        },
    })
}

fn send_outbox(client: &mut WsClient, state: &DurableRunnerState) -> Result<(), Phase3Error> {
    for event in &state.outbox {
        client.send_json(&event.envelope)?;
    }
    Ok(())
}

fn welcome_payload(value: &Value) -> Result<&Value, Phase3Error> {
    if value.get("protocol").and_then(Value::as_str) != Some(PROTOCOL)
        || value.get("version").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || value.get("kind").and_then(Value::as_str) != Some("welcome")
    {
        return Err(Phase3Error::invalid("expected a PRP v1 welcome envelope"));
    }
    value
        .get("payload")
        .ok_or_else(|| Phase3Error::invalid("welcome payload is required"))
}

pub fn run_durable_runner(
    config: DurableRunnerConfig,
    bootstrap_ticket: BootstrapTicket,
) -> Result<(), Phase3Error> {
    if config.p0_reserve_bytes >= config.max_outbox_bytes {
        return Err(Phase3Error::invalid(
            "P0 reserve must be smaller than the outbox limit",
        ));
    }
    // Resolve once before a bearer can be sent. Reconnects use only this validated,
    // concrete address set, so DNS cannot redirect an authenticated retry.
    let target = ResolvedWsTarget::resolve(&config.connect_url)?;
    let store = DurableStateStore::new(&config.state_dir)?;
    let (mut state, recovered) = store.load_or_create(&config)?;
    if recovered {
        state.reconnect_count += 1;
        state.record_diagnostic("runner process restored the same durable identity");
        enqueue_event(
            &mut state,
            &config,
            "runner.reconciled",
            0,
            json!({
                "runnerInstanceId": config.runner_instance_id,
                "normalizedSessionId": config.normalized_session_id,
                "turnId": config.turn_id,
                "itemId": config.item_id,
                "outcome": "same_durable_session_resumed",
            }),
            None,
        )?;
        store.save(&state)?;
    }
    let mut bootstrap_ticket = Some(bootstrap_ticket);
    let mut connection_lease_token: Option<SensitiveString> = None;
    let started = Instant::now();

    loop {
        if started.elapsed() > config.max_runtime {
            state.recoverable_failure = Some("transport_reconnect_deadline_exceeded".to_owned());
            state.lifecycle = "recoverable_failure".to_owned();
            state.record_diagnostic("transport reconnect deadline exceeded");
            store.save(&state)?;
            return Err(Phase3Error::invalid(
                "transport reconnect deadline exceeded; durable state is preserved",
            ));
        }
        let authorization = connection_lease_token
            .as_ref()
            .map(SensitiveString::expose)
            .or_else(|| bootstrap_ticket.as_ref().map(BootstrapTicket::expose))
            .ok_or_else(|| {
                Phase3Error::invalid(
                    "transport capability is unavailable; a fresh runner bootstrap is required",
                )
            })?;
        let mut client = match WsClient::connect(&target, authorization, config.max_frame_bytes) {
            Ok(client) => client,
            Err(error) => {
                let text = error.to_string();
                if text.contains("401") || text.contains("403") {
                    state.recoverable_failure = Some("lease_expired_requires_bootstrap".to_owned());
                    state.lifecycle = "recoverable_failure".to_owned();
                    state.record_diagnostic(
                        "connection lease expired; a fresh bootstrap may resume this state",
                    );
                    store.save(&state)?;
                    return Err(Phase3Error::invalid(
                        "connection lease expired; durable state requires a fresh bootstrap",
                    ));
                }
                state.record_diagnostic(format!("transport reconnect scheduled: {text}"));
                store.save(&state)?;
                thread::sleep(config.reconnect_delay);
                continue;
            }
        };

        client.send_json(&hello_envelope(&state, &config))?;
        let mut welcome = loop {
            match client.receive_json() {
                Ok(Some(value)) => break value,
                Ok(None) if started.elapsed() <= config.max_runtime => continue,
                Ok(None) => {
                    return Err(Phase3Error::invalid("welcome timed out"));
                }
                Err(error) => {
                    state.record_diagnostic(error.to_string());
                    store.save(&state)?;
                    thread::sleep(config.reconnect_delay);
                    continue;
                }
            }
        };
        let next_lease_token = match welcome.pointer_mut("/payload/connectionLeaseToken") {
            Some(Value::String(value)) => {
                let token = std::mem::take(value);
                *value = "[REDACTED]".to_owned();
                Some(SensitiveString::new(token))
            }
            _ => None,
        };
        let payload = welcome_payload(&welcome)?;
        let selected_version = payload
            .get("selectedVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| Phase3Error::invalid("welcome selectedVersion is required"))?;
        if selected_version != PROTOCOL_VERSION {
            return Err(Phase3Error::invalid(
                "mock core selected an unsupported version",
            ));
        }
        if let Some(token) = next_lease_token {
            connection_lease_token = Some(token);
        }
        // A bootstrap ticket is one-use. Clear it as soon as the authenticated welcome
        // has exchanged it for a connection lease.
        bootstrap_ticket.take();
        if let Some(acked_source_seq) = payload.get("ackedSourceSeq").and_then(Value::as_u64) {
            state.apply_ack(acked_source_seq)?;
        }
        state.lifecycle =
            if state.lifecycle == "connecting" || state.lifecycle == "recoverable_failure" {
                "ready".to_owned()
            } else {
                state.lifecycle.clone()
            };
        state.recoverable_failure = None;
        store.save(&state)?;

        let initial_delivery = (|| -> Result<(), Phase3Error> {
            if let Some(commands) = payload.get("pendingCommands").and_then(Value::as_array) {
                for command in commands {
                    match process_command(&mut state, &store, &config, command) {
                        Ok(processed) => {
                            client.send_json(&command_result_envelope(&state, &processed))?
                        }
                        Err(error) => {
                            state.record_diagnostic(error.to_string());
                            store.save(&state)?;
                        }
                    }
                }
            }
            send_outbox(&mut client, &state)
        })();
        if let Err(error) = initial_delivery {
            state.record_diagnostic(error.to_string());
            state.reconnect_count += 1;
            store.save(&state)?;
            thread::sleep(config.reconnect_delay);
            continue;
        }

        let mut revoke_deadline: Option<Instant> = None;
        let disconnected = loop {
            if (state.stop_after_flush || state.lifecycle == "revoked") && state.outbox.is_empty() {
                state.lifecycle = if state.lifecycle == "revoked" {
                    "revoked".to_owned()
                } else {
                    "stopped".to_owned()
                };
                store.save(&state)?;
                connection_lease_token.take();
                bootstrap_ticket.take();
                return Ok(());
            }
            if revoke_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                state.record_diagnostic(
                    "revocation flush deadline elapsed; unacked durable events remain preserved",
                );
                store.save(&state)?;
                connection_lease_token.take();
                bootstrap_ticket.take();
                return Ok(());
            }
            match client.receive_json() {
                Ok(None) => continue,
                Err(error) => {
                    state.record_diagnostic(error.to_string());
                    if state.lifecycle == "revoked" {
                        store.save(&state)?;
                        connection_lease_token.take();
                        bootstrap_ticket.take();
                        return Ok(());
                    }
                    state.reconnect_count += 1;
                    store.save(&state)?;
                    break true;
                }
                Ok(Some(message)) => match message.get("kind").and_then(Value::as_str) {
                    Some("ack") => {
                        let acked = message
                            .pointer("/payload/ackedSourceSeq")
                            .and_then(Value::as_u64)
                            .ok_or_else(|| Phase3Error::invalid("ACK cursor is required"))?;
                        state.apply_ack(acked)?;
                        store.save(&state)?;
                    }
                    Some("command") => {
                        let command = message
                            .get("payload")
                            .ok_or_else(|| Phase3Error::invalid("command payload is required"))?;
                        match process_command(&mut state, &store, &config, command) {
                            Ok(processed) => {
                                let delivery = client
                                    .send_json(&command_result_envelope(&state, &processed))
                                    .and_then(|()| send_outbox(&mut client, &state));
                                if let Err(error) = delivery {
                                    state.record_diagnostic(error.to_string());
                                    if state.lifecycle == "revoked" {
                                        store.save(&state)?;
                                        connection_lease_token.take();
                                        bootstrap_ticket.take();
                                        return Ok(());
                                    }
                                    state.reconnect_count += 1;
                                    store.save(&state)?;
                                    break true;
                                }
                            }
                            Err(error) => {
                                state.record_diagnostic(error.to_string());
                                store.save(&state)?;
                            }
                        }
                    }
                    Some("revoke") => {
                        state.lifecycle = "revoked".to_owned();
                        state.stop_after_flush = true;
                        revoke_deadline.get_or_insert_with(|| {
                            Instant::now()
                                .checked_add(REVOKE_FLUSH_TIMEOUT)
                                .unwrap_or_else(Instant::now)
                        });
                        state
                            .record_diagnostic("connection lease revoked; flushing durable events");
                        store.save(&state)?;
                        if let Err(error) = send_outbox(&mut client, &state) {
                            state.record_diagnostic(error.to_string());
                            store.save(&state)?;
                            connection_lease_token.take();
                            bootstrap_ticket.take();
                            return Ok(());
                        }
                    }
                    Some("ping") => {
                        let pong = client.send_json(&json!({
                            "protocol": PROTOCOL,
                            "version": PROTOCOL_VERSION,
                            "kind": "pong",
                            "runnerInstanceId": state.runner_instance_id,
                            "payload": {
                                "lifecycle": state.lifecycle,
                                "outboxBytes": state.outbox_bytes(),
                                "ackedSourceSeq": state.acked_source_seq,
                            },
                        }));
                        if let Err(error) = pong {
                            state.record_diagnostic(error.to_string());
                            if state.lifecycle == "revoked" {
                                store.save(&state)?;
                                connection_lease_token.take();
                                bootstrap_ticket.take();
                                return Ok(());
                            }
                            state.reconnect_count += 1;
                            store.save(&state)?;
                            break true;
                        }
                    }
                    _ => {
                        state.record_diagnostic(
                            "malformed or unsupported control frame closed the connection",
                        );
                        store.save(&state)?;
                        if state.lifecycle == "revoked" {
                            connection_lease_token.take();
                            bootstrap_ticket.take();
                            return Ok(());
                        }
                        break true;
                    }
                },
            }
        };
        if disconnected {
            thread::sleep(config.reconnect_delay);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENVIRONMENT_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn config(root: &Path) -> DurableRunnerConfig {
        DurableRunnerConfig {
            connect_url: "ws://127.0.0.1:1/phase3/connect".to_owned(),
            state_dir: root.to_path_buf(),
            runner_instance_id: "runner_phase3_stable".to_owned(),
            environment_lease_id: "lease_phase3_stable".to_owned(),
            run_id: "run_phase3_stable".to_owned(),
            normalized_session_id: "session_phase3_stable".to_owned(),
            turn_id: "turn_phase3_stable".to_owned(),
            item_id: "item_phase3_stable".to_owned(),
            runner_version: "0.3.0".to_owned(),
            runner_digest: "sha256:phase3-approved".to_owned(),
            fake_harness_path: None,
            fake_harness_script_path: None,
            max_outbox_bytes: 16 * 1024,
            p0_reserve_bytes: 8 * 1024,
            max_frame_bytes: 1024 * 1024,
            reconnect_delay: Duration::from_millis(1),
            max_runtime: Duration::from_millis(10),
        }
    }

    fn temporary_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "paperclip-runner-phase3-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn command(id: &str, sequence: u64, command_type: &str, payload: Value) -> Value {
        json!({
            "schema": "paperclip.prp.command.v1",
            "commandId": id,
            "controllerSeq": sequence,
            "type": command_type,
            "issuedAt": deterministic_time(sequence),
            "payload": payload,
        })
    }

    #[test]
    fn durable_state_restores_identity_outbox_and_cumulative_ack() {
        let root = temporary_root("restore");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, recovered) = store.load_or_create(&config).unwrap();
        assert!(!recovered);
        let session_id = state.normalized_session_id.clone();
        enqueue_event(
            &mut state,
            &config,
            "session.started",
            0,
            json!({ "session": session_id }),
            None,
        )
        .unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "status": "succeeded" }),
            None,
        )
        .unwrap();
        let first_event_id = state.outbox[0].source_event_id.clone();
        store.save(&state).unwrap();

        let (mut restored, recovered) = store.load_or_create(&config).unwrap();
        assert!(recovered);
        assert_eq!(restored.runner_instance_id, config.runner_instance_id);
        assert_eq!(restored.normalized_session_id, config.normalized_session_id);
        assert_eq!(restored.outbox[0].source_event_id, first_event_id);
        restored.apply_ack(1).unwrap();
        assert_eq!(restored.acked_source_seq, 1);
        assert_eq!(restored.outbox.len(), 1);
        assert!(restored.apply_ack(0).is_err());
        assert!(restored.apply_ack(3).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_command_has_one_logical_effect_and_no_new_events() {
        let root = temporary_root("command-dedupe");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let value = command("command_prepare", 1, "run.prepare", json!({}));
        let first = process_command(&mut state, &store, &config, &value).unwrap();
        let event_count = state.outbox.len();
        let second = process_command(&mut state, &store, &config, &value).unwrap();
        assert_eq!(first.result, second.result);
        assert_eq!(first.logical_effect_count, 1);
        assert_eq!(state.outbox.len(), event_count);
        assert_eq!(state.processed_commands.len(), 1);
        assert!(process_command(
            &mut state,
            &store,
            &config,
            &command(
                "command_prepare",
                1,
                "run.prepare",
                json!({ "changed": true })
            )
        )
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pressure_coalesces_p2_preserves_p0_and_stays_bounded() {
        let root = temporary_root("pressure");
        let mut config = config(&root);
        config.max_outbox_bytes = 12 * 1024;
        config.p0_reserve_bytes = 6 * 1024;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        process_command(
            &mut state,
            &store,
            &config,
            &command("command_pressure", 1, "fault.storage_pressure", json!({})),
        )
        .unwrap();
        assert!(state.backpressure);
        assert!(state.outbox_bytes() <= config.max_outbox_bytes);
        assert_eq!(
            state
                .outbox
                .iter()
                .filter(|event| event.event_type == "item.delta")
                .count(),
            1
        );
        assert!(state
            .outbox
            .iter()
            .any(|event| event.priority == 0 && event.event_type == "runner.backpressure"));
        let persisted = fs::read_to_string(store.path()).unwrap();
        assert!(!persisted.contains("must-not-persist"));
        assert!(persisted.contains("[REDACTED]"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn drain_rejects_new_turn_and_revoke_preserves_unacked_events() {
        let root = temporary_root("drain");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        process_command(
            &mut state,
            &store,
            &config,
            &command("command_drain", 1, "runner.drain", json!({})),
        )
        .unwrap();
        let before = state.outbox.len();
        let rejected = process_command(
            &mut state,
            &store,
            &config,
            &command("command_turn", 2, "turn.start", json!({})),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.logical_effect_count, 0);
        assert_eq!(state.outbox.len(), before);
        state.lifecycle = "revoked".to_owned();
        store.save(&state).unwrap();
        let (restored, _) = store.load_or_create(&config).unwrap();
        assert_eq!(restored.lifecycle, "revoked");
        assert_eq!(restored.outbox.len(), before);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_p0_records_an_explicit_unrecoverable_outcome() {
        let root = temporary_root("unrecoverable");
        let mut config = config(&root);
        config.max_outbox_bytes = 512;
        config.p0_reserve_bytes = 256;
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        let result = enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "evidence": "x".repeat(4_096) }),
            None,
        );
        assert!(result.is_err());
        assert_eq!(
            state.unrecoverable_outcome.as_deref(),
            Some("p0_storage_exhausted")
        );
        assert_eq!(state.lifecycle, "unrecoverable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn destination_validation_rejects_public_private_wildcard_and_mixed_answers() {
        for (label, url, addresses) in [
            (
                "public",
                "ws://8.8.8.8:443/phase3/connect",
                vec!["8.8.8.8:443".parse::<SocketAddr>().unwrap()],
            ),
            (
                "private",
                "ws://10.1.2.3:3100/phase3/connect",
                vec!["10.1.2.3:3100".parse::<SocketAddr>().unwrap()],
            ),
            (
                "wildcard",
                "ws://0.0.0.0:3100/phase3/connect",
                vec!["0.0.0.0:3100".parse::<SocketAddr>().unwrap()],
            ),
            (
                "mixed-answer",
                "ws://mixed.test:3100/phase3/connect",
                vec![
                    "127.0.0.1:3100".parse::<SocketAddr>().unwrap(),
                    "192.0.2.9:3100".parse::<SocketAddr>().unwrap(),
                ],
            ),
        ] {
            let result = resolve_ws_target_with(url, |_host, _port| Ok(addresses));
            assert!(result.is_err(), "{label} destination must fail closed");
        }
    }

    #[test]
    fn destination_validation_rejects_malformed_userinfo_query_and_fragment_before_resolution() {
        for url in [
            "wss://127.0.0.1:3100/phase3/connect",
            "WS://127.0.0.1:3100/phase3/connect",
            "ws://127.0.0.1/phase3/connect",
            "ws://127.0.0.1:0/phase3/connect",
            "ws://[::1:3100/phase3/connect",
            "ws://user@127.0.0.1:3100/phase3/connect",
            "ws://127.0.0.1:3100/phase3/connect?ticket=ambiguous",
            "ws://127.0.0.1:3100/phase3/connect#fragment",
            "ws://127.0.0.1:3100/phase3\\connect",
        ] {
            let mut resolution_attempted = false;
            let result = resolve_ws_target_with(url, |_host, _port| {
                resolution_attempted = true;
                Ok(vec!["127.0.0.1:3100".parse().unwrap()])
            });
            assert!(result.is_err(), "ambiguous URL must be rejected: {url}");
            assert!(
                !resolution_attempted,
                "malformed URL reached destination resolution: {url}"
            );
        }
    }

    #[test]
    fn destination_validation_accepts_only_concrete_loopback_answers() {
        let target =
            resolve_ws_target_with("ws://localhost:3100/phase3/connect", |_host, _port| {
                Ok(vec![
                    "127.42.0.9:3100".parse().unwrap(),
                    "[::1]:3100".parse().unwrap(),
                ])
            })
            .unwrap();
        assert_eq!(target.addresses.len(), 2);
        assert!(target
            .addresses
            .iter()
            .all(|address| address.ip().is_loopback()));
    }

    #[test]
    fn oversized_outbound_websocket_frame_is_rejected_before_write() {
        let error = encode_masked_frame(0x1, b"ninebytes", [0; 4], 8).unwrap_err();
        assert!(error
            .to_string()
            .contains("outbound WebSocket frame exceeds"));
    }

    #[test]
    fn oversized_inbound_websocket_frame_is_rejected_before_allocation() {
        let error = checked_inbound_frame_length(9, 8).unwrap_err();
        assert!(error
            .to_string()
            .contains("inbound WebSocket frame exceeds"));
    }

    #[test]
    fn revoked_runner_rejects_turn_with_zero_effects_and_preserves_existing_outbox() {
        let root = temporary_root("revoked-command");
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        let (mut state, _) = store.load_or_create(&config).unwrap();
        enqueue_event(
            &mut state,
            &config,
            "run.terminal",
            0,
            json!({ "status": "succeeded" }),
            None,
        )
        .unwrap();
        state.lifecycle = "revoked".to_owned();
        let before = state.outbox.clone();
        let rejected = process_command(
            &mut state,
            &store,
            &config,
            &command("command_after_revoke", 1, "turn.start", json!({})),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.logical_effect_count, 0);
        assert_eq!(state.outbox, before);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_state_write_ignores_preplanted_predictable_symlink_and_uses_private_modes() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("state-symlink");
        let victim = root.join("victim.txt");
        fs::write(&victim, "unchanged").unwrap();
        let planted = root.join("runner-state.json.next");
        symlink(&victim, &planted).unwrap();
        let config = config(&root);
        let store = DurableStateStore::new(&root).unwrap();
        store.save(&DurableRunnerState::new(&config)).unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "unchanged");
        assert!(fs::symlink_metadata(&planted)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(store.path()).unwrap().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn durable_state_load_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("state-load-symlink");
        let config = config(&root);
        let victim = root.join("victim.json");
        fs::write(
            &victim,
            serde_json::to_vec(&DurableRunnerState::new(&config)).unwrap(),
        )
        .unwrap();
        symlink(&victim, root.join("runner-state.json")).unwrap();
        let store = DurableStateStore::new(&root).unwrap();
        assert!(store.load_or_create(&config).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn captured_bootstrap_is_removed_and_absent_from_a_real_child_environment() {
        let _guard = ENVIRONMENT_TEST_LOCK.lock().unwrap();
        let secret = format!("bootstrap-environment-regression-{}", std::process::id());
        std::env::set_var("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET", &secret);
        let ticket = capture_bootstrap_ticket().unwrap().unwrap();
        assert!(std::env::var_os("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET").is_none());

        let mut child = SupervisedProcess::spawn(
            Path::new("/usr/bin/env"),
            &[],
            Duration::from_millis(50),
            16 * 1024,
        )
        .unwrap();
        let mut environment = Vec::new();
        while let Some(line) = child
            .receive_stdout_line(Duration::from_millis(250))
            .unwrap()
        {
            environment.push(line);
        }
        let exit = child.wait().unwrap();
        assert!(exit.success);
        let dump = environment.join("\n");
        assert!(!dump.contains("PAPERCLIP_RUNNER_BOOTSTRAP_TICKET"));
        assert!(!dump.contains(&secret));
        drop(ticket);
    }
}
