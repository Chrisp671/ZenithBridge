import sys
import os
import threading
import time
import subprocess


def main():
    try:
        from winpty import PtyProcess
    except ImportError as e:
        sys.stderr.write("ERROR: pywinpty not installed: {}\n".format(e))
        sys.stderr.write("Install with: pip install pywinpty\n")
        sys.stderr.flush()
        sys.exit(1)

    # Build command from all arguments (not just argv[1])
    args = sys.argv[1:] if len(sys.argv) > 1 else ["powershell.exe"]
    cmd = subprocess.list2cmdline(args)

    # Get dimensions from environment or use defaults
    try:
        cols = int(os.environ.get("TERM_COLS", "120"))
    except (ValueError, TypeError):
        cols = 120
    try:
        rows = int(os.environ.get("TERM_ROWS", "30"))
    except (ValueError, TypeError):
        rows = 30

    sys.stderr.write("[ConPTY] Starting: {} ({}x{})\n".format(cmd, cols, rows))
    sys.stderr.flush()

    try:
        proc = PtyProcess.spawn(cmd, dimensions=(rows, cols))
    except Exception as e:
        sys.stderr.write("ERROR: Failed to spawn ConPTY: {}\n".format(e))
        sys.stderr.flush()
        sys.exit(1)

    sys.stderr.write("[ConPTY] Process spawned (PID: {})\n".format(proc.pid))
    sys.stderr.flush()

    exit_code = [None]

    # Resize protocol: Node.js sends \x1b]9999;COLSxROWS\x07 via stdin
    RESIZE_START = b"\x1b]9999;"
    RESIZE_END = b"\x07"

    def read_pty():
        """Read from ConPTY and write to stdout (goes to Node.js)"""
        while proc.isalive():
            try:
                data = proc.read(4096)
                if data:
                    if isinstance(data, str):
                        sys.stdout.buffer.write(data.encode("utf-8", "replace"))
                    else:
                        sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
            except EOFError:
                break
            except Exception as e:
                sys.stderr.write("[ConPTY] Read error: {}\n".format(e))
                sys.stderr.flush()
                break
        exit_code[0] = proc.exitstatus if proc.exitstatus is not None else 1
        sys.stderr.write("[ConPTY] Exited with code: {}\n".format(exit_code[0]))
        sys.stderr.flush()

    def read_stdin():
        """Read from stdin (from Node.js) and write to ConPTY, handling resize commands"""
        stdin_fd = sys.stdin.fileno()
        buf = b""
        while proc.isalive():
            try:
                data = os.read(stdin_fd, 4096)
                if not data:
                    break
                buf += data

                # Process any resize escape sequences in the buffer
                while RESIZE_START in buf:
                    pre_idx = buf.index(RESIZE_START)
                    # Send data before the resize command to the PTY
                    if pre_idx > 0:
                        proc.write(buf[:pre_idx].decode("utf-8", "replace"))

                    end_idx = buf.find(RESIZE_END, pre_idx)
                    if end_idx == -1:
                        # Incomplete resize sequence, keep in buffer and wait
                        buf = buf[pre_idx:]
                        break

                    # Parse and apply the resize command
                    resize_data = buf[pre_idx + len(RESIZE_START):end_idx].decode("utf-8")
                    buf = buf[end_idx + 1:]
                    try:
                        c, r = resize_data.split("x")
                        proc.setwinsize(int(r), int(c))
                    except Exception as e:
                        sys.stderr.write("[ConPTY] Resize error: {}\n".format(e))
                        sys.stderr.flush()
                else:
                    # No (more) resize commands in buffer, send all to PTY
                    if buf:
                        proc.write(buf.decode("utf-8", "replace"))
                        buf = b""
            except (OSError, EOFError):
                break
            except Exception as e:
                sys.stderr.write("[ConPTY] Stdin error: {}\n".format(e))
                sys.stderr.flush()
                break

    # Start I/O threads
    pty_thread = threading.Thread(target=read_pty, daemon=True)
    stdin_thread = threading.Thread(target=read_stdin, daemon=True)
    pty_thread.start()
    stdin_thread.start()

    # Wait for PTY output thread to finish (means process exited)
    pty_thread.join()

    # Small delay for any final output
    time.sleep(0.1)

    # Ensure the ConPTY child process is terminated to prevent orphans
    try:
        if proc.isalive():
            proc.terminate(force=True)
    except Exception:
        pass

    sys.exit(exit_code[0] if exit_code[0] is not None else 1)


if __name__ == "__main__":
    main()
