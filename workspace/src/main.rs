//! lisa-workspace: binário do modo Workspace da Lisa (daemon, UI e hooks).

use std::io::Read;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use lisa_workspace::daemon::client::connect_existing;
use lisa_workspace::daemon::service::Workspace;
use lisa_workspace::daemon::{BuildInfo, Daemon, RuntimePaths};
use lisa_workspace::protocol::{ClientKind, ClientMsg};
use lisa_workspace::registry::{default_worktree_root, lisa_home};

#[derive(Parser)]
#[command(name = "lisa-workspace", version, about = "Lisa Workspace mode")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Roda o daemon que segura os terminais dos agentes
    Daemon,
    /// Abre a interface do Workspace
    Ui,
    /// Reporta um evento de hook de agente ao daemon
    Hook {
        /// Nome do evento (ex.: Stop, Notification, SessionStart)
        event: String,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Daemon => {
            // Sessão própria: fechar o terminal que abriu a UI não derruba o daemon
            let _ = rustix::process::setsid();
            let workspace = Workspace::open(
                lisa_home().join("workspace").join("state.json"),
                default_worktree_root(),
            )?;
            let daemon = Daemon::new(
                RuntimePaths::resolve(),
                BuildInfo::current(),
                Arc::new(workspace),
            );
            daemon.run()?;
            Ok(())
        }
        Command::Hook { event } => {
            hook(event);
            Ok(())
        }
        Command::Ui => anyhow::bail!("not implemented yet"),
    }
}

/// Repassa um evento de hook ao daemon. Nunca falha: o agente não pode travar por causa da Lisa.
fn hook(event: String) {
    let pane = match std::env::var("LISA_PANE_ID") {
        Ok(p) if !p.is_empty() => p,
        _ => return,
    };
    let mut payload = String::new();
    let _ = std::io::stdin()
        .take(64 * 1024)
        .read_to_string(&mut payload);
    let paths = RuntimePaths::resolve();
    if let Some(mut conn) = connect_existing(&paths, &BuildInfo::current(), ClientKind::Hook) {
        let _ = conn.send(&ClientMsg::HookEvent {
            pane,
            event,
            payload,
        });
    }
}
