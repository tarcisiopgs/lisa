//! lisa-workspace: binário do modo Workspace da Lisa (daemon, UI e hooks).

use std::sync::Arc;

use clap::{Parser, Subcommand};
use lisa_workspace::daemon::service::Workspace;
use lisa_workspace::daemon::{BuildInfo, Daemon, RuntimePaths};
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
        Command::Ui | Command::Hook { .. } => anyhow::bail!("not implemented yet"),
    }
}
