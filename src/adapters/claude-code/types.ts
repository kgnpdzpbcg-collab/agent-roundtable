export type ClaudeSettingSource = "user" | "project" | "local";

export interface ClaudeCodeAdapterOptions {
  /**
   * 默认不指定，让官方 Agent SDK 使用随包提供的 Claude Code runtime。
   * 如需强制复用本机已安装的 claude，可通过该字段或 CLAUDE_CODE_BIN 指定路径。
   */
  pathToClaudeCodeExecutable?: string;
  settingSources?: ClaudeSettingSource[];
  env?: Record<string, string | undefined>;
}
