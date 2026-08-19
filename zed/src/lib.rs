use zed_extension_api::{self as zed, LanguageServerId, Result, Worktree};

const SERVER_BINARY_NAME: &str = "dream-language-server";

struct DreamExtension;

impl zed::Extension for DreamExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command> {
        let command = worktree.which(SERVER_BINARY_NAME).ok_or_else(|| {
            format!(
                "Could not find {SERVER_BINARY_NAME} in the worktree PATH; add ~/.bun/bin to PATH"
            )
        })?;

        Ok(zed::Command {
            command,
            args: Vec::new(),
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(DreamExtension);
