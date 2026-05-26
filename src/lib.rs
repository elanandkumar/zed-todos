use std::path::PathBuf;
use zed_extension_api::{self as zed, LanguageServerId, Result, Worktree};

// Embedded at compile time — edits to server.js require a WASM rebuild.
const SERVER_JS: &str = include_str!("../lsp-server/server.js");

struct TodoExtension {
    server_path: PathBuf,
}

impl zed::Extension for TodoExtension {
    fn new() -> Self {
        // CWD in the WASM sandbox is the extension's work directory.
        // Write the embedded server.js there so Node can find it.
        let work_dir = std::env::current_dir().unwrap_or_default();
        let lsp_dir = work_dir.join("lsp-server");
        let server_path = lsp_dir.join("server.js");
        std::fs::create_dir_all(&lsp_dir).ok();
        std::fs::write(&server_path, SERVER_JS).ok();
        TodoExtension { server_path }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        _worktree: &Worktree,
    ) -> Result<zed::Command> {
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![self.server_path.to_string_lossy().to_string()],
            env: Default::default(),
        })
    }
}

zed::register_extension!(TodoExtension);
