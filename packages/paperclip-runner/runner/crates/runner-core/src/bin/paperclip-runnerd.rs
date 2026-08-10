use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use paperclip_runner_core::phase2::{run_local_runner, Phase2Error, RunnerConfig};
use paperclip_runner_core::phase3::{
    capture_bootstrap_ticket, run_durable_runner, BootstrapTicket, DurableRunnerConfig,
};

fn value(args: &[String], name: &str) -> Result<String, Phase2Error> {
    let index = args
        .iter()
        .position(|argument| argument == name)
        .ok_or_else(|| Phase2Error::invalid(format!("missing required argument {name}")))?;
    args.get(index + 1)
        .cloned()
        .ok_or_else(|| Phase2Error::invalid(format!("missing value for {name}")))
}

fn optional_u64(args: &[String], name: &str) -> Result<Option<u64>, Phase2Error> {
    let Some(index) = args.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    let value = args
        .get(index + 1)
        .ok_or_else(|| Phase2Error::invalid(format!("missing value for {name}")))?;
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|error| Phase2Error::invalid(format!("invalid {name}: {error}")))
}

fn usize_value(args: &[String], name: &str, default: usize) -> Result<usize, Phase2Error> {
    optional_u64(args, name)?.map_or(Ok(default), |value| {
        usize::try_from(value)
            .map_err(|error| Phase2Error::invalid(format!("invalid {name}: {error}")))
    })
}

fn duration_value(args: &[String], name: &str, default: u64) -> Result<Duration, Phase2Error> {
    Ok(Duration::from_millis(
        optional_u64(args, name)?.unwrap_or(default),
    ))
}

fn run_phase3(
    args: &[String],
    bootstrap_ticket: Option<BootstrapTicket>,
) -> Result<(), Phase2Error> {
    let config = DurableRunnerConfig {
        connect_url: value(args, "--connect-url")?,
        state_dir: PathBuf::from(value(args, "--state-dir")?),
        runner_instance_id: value(args, "--runner-id")?,
        environment_lease_id: value(args, "--environment-lease-id")?,
        run_id: value(args, "--run-id")?,
        normalized_session_id: value(args, "--session-id")?,
        turn_id: value(args, "--turn-id")?,
        item_id: value(args, "--item-id")?,
        runner_version: value(args, "--runner-version")?,
        runner_digest: value(args, "--runner-digest")?,
        fake_harness_path: args
            .iter()
            .any(|argument| argument == "--fake-harness")
            .then(|| value(args, "--fake-harness").map(PathBuf::from))
            .transpose()?,
        fake_harness_script_path: args
            .iter()
            .any(|argument| argument == "--fake-harness-script")
            .then(|| value(args, "--fake-harness-script").map(PathBuf::from))
            .transpose()?,
        max_outbox_bytes: usize_value(args, "--max-outbox-bytes", 64 * 1024)?,
        p0_reserve_bytes: usize_value(args, "--p0-reserve-bytes", 32 * 1024)?,
        max_frame_bytes: usize_value(args, "--max-frame-bytes", 1024 * 1024)?,
        reconnect_delay: duration_value(args, "--reconnect-delay-ms", 25)?,
        max_runtime: duration_value(args, "--max-runtime-ms", 15_000)?,
    };
    let bootstrap_ticket = bootstrap_ticket
        .ok_or_else(|| Phase2Error::invalid("runner bootstrap ticket is not available"))?;
    run_durable_runner(config, bootstrap_ticket)
        .map_err(|error| Phase2Error::invalid(error.to_string()))
}

fn run(bootstrap_ticket: Option<BootstrapTicket>) -> Result<(), Phase2Error> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|argument| argument == "--connect-url") {
        return run_phase3(&args, bootstrap_ticket);
    }
    run_local_runner(RunnerConfig {
        run_id: value(&args, "--run-id")?,
        normalized_session_id: value(&args, "--session-id")?,
        runner_instance_id: value(&args, "--runner-id")?,
        fake_harness_path: PathBuf::from(value(&args, "--fake-harness")?),
        script_path: PathBuf::from(value(&args, "--script")?),
        delay_override_ms: optional_u64(&args, "--delay-ms")?,
        log_max_lines: usize_value(&args, "--log-max-lines", 32)?,
        log_max_bytes: usize_value(&args, "--log-max-bytes", 16_384)?,
        harness_max_line_bytes: usize_value(&args, "--harness-max-line-bytes", 64 * 1024)?,
        shutdown_grace: Duration::from_millis(
            optional_u64(&args, "--shutdown-grace-ms")?.unwrap_or(100),
        ),
    })
}

fn main() -> ExitCode {
    // Capture and remove the bootstrap capability before argument parsing or child work.
    let bootstrap_ticket = match capture_bootstrap_ticket() {
        Ok(ticket) => ticket,
        Err(error) => {
            eprintln!("paperclip-runnerd: {error}");
            return ExitCode::FAILURE;
        }
    };
    match run(bootstrap_ticket) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("paperclip-runnerd: {error}");
            ExitCode::FAILURE
        }
    }
}
