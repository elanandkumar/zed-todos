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
        _language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<zed::Command> {
        let server_path = self.server_path()?;
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server_path],
            env: Default::default(),
        })
    }
}

impl TodoExtension {
    fn server_path(&mut self) -> Result<String> {
        let version = zed::npm_package_latest_version(PACKAGE_NAME)?;

        if self.server_path.as_ref().map_or(true, |p| !p.exists()) {
            zed::set_language_server_installation_status(
                "todo-ls",
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(PACKAGE_NAME, &version)?;
        }

        let path = PathBuf::from(SERVER_PATH);
        if !path.exists() {
            return Err(format!("{SERVER_PATH} not found after install").into());
        }

        self.server_path = Some(path);
        Ok(SERVER_PATH.to_string())
    }
}

zed::register_extension!(TodoExtension);
