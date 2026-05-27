use std::path::PathBuf;
use zed_extension_api::{self as zed, LanguageServerId, Result, Worktree};

const PACKAGE_NAME: &str = "@elanandkumar/todo-ls";
const SERVER_PATH: &str = "node_modules/@elanandkumar/todo-ls/server.js";

struct TodoExtension {
    server_path: Option<PathBuf>,
}

impl zed::Extension for TodoExtension {
    fn new() -> Self {
        TodoExtension { server_path: None }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.server_path(language_server_id)?;
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_path.to_string_lossy().to_string()],
            env: Default::default(),
        })
    }
}

impl TodoExtension {
    fn server_path(&mut self, language_server_id: &LanguageServerId) -> Result<PathBuf> {
        let version = zed::npm_package_latest_version(PACKAGE_NAME)?;

        let work_dir = std::env::current_dir().map_err(|e| e.to_string())?;
        let path = work_dir.join(SERVER_PATH);

        if !path.exists() {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(PACKAGE_NAME, &version)?;
        }

        if !path.exists() {
            return Err(format!("{} not found after install", path.display()).into());
        }

        self.server_path = Some(path.clone());
        Ok(path)
    }
}

zed::register_extension!(TodoExtension);
