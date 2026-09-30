//! lisa-workspace: binário do modo Workspace da Lisa (daemon, UI e hooks).

use clap::{Parser, Subcommand};

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
        Command::Daemon | Command::Ui | Command::Hook { .. } => {
            anyhow::bail!("not implemented yet")
        }
    }
}
