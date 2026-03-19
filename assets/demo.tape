# VHS tape for recording Lisa plan-then-run TUI demo
# https://github.com/charmbracelet/vhs

Output assets/demo.gif

Set Shell "zsh"
Set FontSize 14
Set Width 1200
Set Height 650
Set Padding 20
Set TypingSpeed 50ms
Set Theme { "name": "Lisa", "black": "#1a1a2e", "red": "#e74c3c", "green": "#2ecc71", "yellow": "#f1c40f", "blue": "#3498db", "magenta": "#9b59b6", "cyan": "#1abc9c", "white": "#ecf0f1", "brightBlack": "#636e72", "brightRed": "#e74c3c", "brightGreen": "#2ecc71", "brightYellow": "#f1c40f", "brightBlue": "#3498db", "brightMagenta": "#9b59b6", "brightCyan": "#1abc9c", "brightWhite": "#ffffff", "background": "#0d1117", "foreground": "#e6edf3", "selection": "#264f78", "cursor": "#f1c40f" }

# Hide the shell prompt and initial Ink mount delay
Hide
Type "cd /Users/tarcisiopgs/Workspace/lisa/cli && node dist/index.js --demo"
Enter
Sleep 4s
Show

# Capture the full kanban animation: issues queue, process, and complete
Sleep 22s
