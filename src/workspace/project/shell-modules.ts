export const SHELL_MODULES_FILE = "shell-modules.json";

export type ShellModuleSet = Readonly<{
  mainModule: string;
  modules: Record<string, { js?: string; cjs?: string; text?: string }>;
}>;
