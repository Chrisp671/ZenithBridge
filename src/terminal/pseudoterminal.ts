import { spawn, ChildProcess } from "child_process";
import { Terminal } from "@xterm/xterm";
import { Writable } from "stream";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import unixPseudoterminalPy from "./unix_pseudoterminal.py";
import windowsPseudoterminalPy from "./windows_pseudoterminal.py";

export interface Pseudoterminal {
  readonly shell?: Promise<ChildProcess> | undefined;
  readonly kill: () => Promise<void>;
  readonly onExit: Promise<NodeJS.Signals | number>;
  readonly pipe: (terminal: Terminal) => Promise<void>;
  readonly resize?: (columns: number, rows: number) => Promise<void>;
}

export interface PseudoterminalArgs {
  executable: string;
  args?: string[];
  cwd?: string;
  pythonExecutable?: string;
  terminal?: string;
  env?: NodeJS.ProcessEnv;
}

async function writePromise(stream: Writable, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export class UnixPseudoterminal implements Pseudoterminal {
  private static readonly CMDIO_FD = 3;
  public readonly shell: Promise<ChildProcess>;
  public readonly onExit: Promise<NodeJS.Signals | number>;

  constructor(args: PseudoterminalArgs) {
    const child = this.spawnPythonHelper(args);
    this.shell = Promise.resolve(child);
    this.onExit = new Promise(resolve => {
      child.once("exit", (code, signal) => {
        resolve(code ?? signal ?? NaN);
      });
    });
  }

  private spawnPythonHelper(args: PseudoterminalArgs): ChildProcess {
    const python = args.pythonExecutable || "python3";

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...args.env,
      PYTHONIOENCODING: "utf-8",
    };
    
    if (args.terminal) {
      env["TERM"] = args.terminal;
    }

    const child = spawn(
      python,
      ["-c", unixPseudoterminalPy, args.executable, ...(args.args || [])],
      {
        cwd: args.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe", "pipe"], // stdin, stdout, stderr, cmdio
        windowsHide: true,
      }
    );

    // Log stderr for debugging
    child.stderr?.on("data", (chunk: Buffer) => {
      console.error("[PTY stderr]", chunk.toString());
    });

    return child;
  }

  async pipe(terminal: Terminal): Promise<void> {
    const shell = await this.shell;
    
    const reader = (chunk: Buffer | string): void => {
      try {
        terminal.write(chunk.toString());
      } catch (error: unknown) {
        console.error("[Terminal] Write error:", error);
      }
    };

    // Pipe shell output to terminal
    shell.stdout?.on("data", reader);
    shell.stderr?.on("data", reader);
    
    // Pipe terminal input to shell
    const disposable = terminal.onData(async (data: string) => {
      try {
        if (shell.stdin) {
          await writePromise(shell.stdin, data);
        }
      } catch (error) {
        console.error("[Terminal] Input error:", error);
      }
    });

    // Clean up on exit
    this.onExit.catch(() => {}).finally(() => {
      shell.stdout?.removeListener("data", reader);
      shell.stderr?.removeListener("data", reader);
      disposable.dispose();
    });
  }

  async resize(columns: number, rows: number): Promise<void> {
    try {
      const shell = await this.shell;
      const cmdio = shell.stdio[UnixPseudoterminal.CMDIO_FD] as Writable;
      
      if (cmdio) {
        await writePromise(cmdio, `${columns}x${rows}\n`);
      }
    } catch (error) {
      console.warn("[Terminal] Resize failed:", error);
    }
  }

  async kill(): Promise<void> {
    try {
      const shell = await this.shell;
      if (!shell.kill("SIGTERM")) {
        throw new Error("Failed to kill pseudoterminal");
      }
    } catch (error) {
      console.error("[Terminal] Kill failed:", error);
      throw error;
    }
  }
}

export class WindowsPseudoterminal implements Pseudoterminal {
  public readonly shell: Promise<ChildProcess>;
  public readonly onExit: Promise<NodeJS.Signals | number>;
  private scriptPath: string | null = null;

  constructor(args: PseudoterminalArgs) {
    const child = this.spawnPythonHelper(args);
    this.shell = Promise.resolve(child);
    this.onExit = new Promise(resolve => {
      child.once("exit", (code, signal) => {
        resolve(code ?? signal ?? NaN);
      });
    });
  }

  private spawnPythonHelper(args: PseudoterminalArgs): ChildProcess {
    const python = args.pythonExecutable || "python";

    // Write Python script to temp file to avoid Windows command-line quoting issues
    // Passing a multi-line Python script via -c on Windows is unreliable due to
    // how CreateProcessW handles quotes and special characters in the command line.
    this.scriptPath = join(
      tmpdir(),
      `obsidian-pty-${Date.now()}-${Math.random().toString(36).slice(2)}.py`
    );
    writeFileSync(this.scriptPath, windowsPseudoterminalPy, "utf-8");
    console.debug(`[Windows PTY] Wrote helper script to: ${this.scriptPath}`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...args.env,
      PYTHONIOENCODING: "utf-8",
    };

    if (args.terminal) {
      env["TERM"] = args.terminal;
    }

    const child = spawn(
      python,
      [this.scriptPath, args.executable, ...(args.args || [])],
      {
        cwd: args.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    // Clean up temp file when process exits
    const scriptToClean = this.scriptPath;
    child.once("exit", () => {
      try {
        unlinkSync(scriptToClean);
      } catch (error) {
        console.warn(`[Windows PTY] Failed to clean up temp script ${scriptToClean}:`, error);
      }
    });

    // Also clean up on spawn error
    child.on("error", (spawnError) => {
      console.error("[Windows PTY] Spawn error:", spawnError);
      try {
        unlinkSync(scriptToClean);
      } catch (cleanupError) {
        console.warn(`[Windows PTY] Failed to clean up temp script ${scriptToClean}:`, cleanupError);
      }
    });

    // Log stderr for debugging (ConPTY status messages)
    child.stderr?.on("data", (chunk: Buffer) => {
      console.debug("[Windows PTY stderr]", chunk.toString().trim());
    });

    return child;
  }

  async pipe(terminal: Terminal): Promise<void> {
    const shell = await this.shell;

    const reader = (chunk: Buffer | string): void => {
      try {
        terminal.write(chunk.toString());
      } catch (error: unknown) {
        console.error("[Terminal] Write error:", error);
      }
    };

    // Only pipe stdout to terminal (stderr goes to console for debugging)
    shell.stdout?.on("data", reader);

    // Pipe terminal input to shell stdin
    const disposable = terminal.onData(async (data: string) => {
      try {
        if (shell.stdin && !shell.stdin.destroyed) {
          await writePromise(shell.stdin, data);
        }
      } catch (error) {
        console.error("[Terminal] Input error:", error);
      }
    });

    // Clean up on exit
    this.onExit.catch(() => {}).finally(() => {
      shell.stdout?.removeListener("data", reader);
      disposable.dispose();
    });
  }

  async resize(columns: number, rows: number): Promise<void> {
    try {
      const shell = await this.shell;
      if (shell.stdin && !shell.stdin.destroyed) {
        // Send resize command using custom OSC escape sequence
        // The Python helper script intercepts this and calls proc.setwinsize()
        shell.stdin.write(`\x1b]9999;${columns}x${rows}\x07`);
      }
    } catch (error) {
      console.warn("[Terminal] Resize failed:", error);
    }
  }

  async kill(): Promise<void> {
    try {
      const shell = await this.shell;
      shell.kill();
    } catch (error) {
      console.error("[Terminal] Kill failed:", error);
      throw error;
    }
  }
}

export class ChildProcessPseudoterminal implements Pseudoterminal {
  public readonly shell: Promise<ChildProcess>;
  public readonly onExit: Promise<NodeJS.Signals | number>;

  constructor(args: PseudoterminalArgs) {
    const child = this.spawnChildProcess(args);
    this.shell = Promise.resolve(child);
    this.onExit = new Promise(resolve => {
      child.once("exit", (code, signal) => {
        resolve(code ?? signal ?? NaN);
      });
    });
  }

  private spawnChildProcess(args: PseudoterminalArgs): ChildProcess {
    return spawn(args.executable, args.args || [], {
      cwd: args.cwd,
      env: {
        ...process.env,
        ...args.env,
        TERM: args.terminal || "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  }

  async pipe(terminal: Terminal): Promise<void> {
    const shell = await this.shell;
    
    const reader = (chunk: Buffer | string): void => {
      try {
        terminal.write(chunk.toString());
      } catch (error: unknown) {
        console.error("[Terminal] Write error:", error);
      }
    };

    // Pipe shell output to terminal
    shell.stdout?.on("data", reader);
    shell.stderr?.on("data", reader);
    
    // Pipe terminal input to shell
    const disposable = terminal.onData(async (data: string) => {
      try {
        if (shell.stdin && !shell.stdin.destroyed) {
          await writePromise(shell.stdin, data);
        }
      } catch (error) {
        console.error("[Terminal] Input error:", error);
      }
    });

    // Clean up on exit
    this.onExit.catch(() => {}).finally(() => {
      shell.stdout?.removeListener("data", reader);
      shell.stderr?.removeListener("data", reader);
      disposable.dispose();
    });
  }

  async kill(): Promise<void> {
    try {
      const shell = await this.shell;
      if (!shell.kill("SIGTERM")) {
        throw new Error("Failed to kill child process");
      }
    } catch (error) {
      console.error("[Terminal] Kill failed:", error);
      throw error;
    }
  }
}