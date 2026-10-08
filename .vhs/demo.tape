# VHS demo tape for omnexx
# Run with: vhs < demo.tape

Set Title "omnexx demo"
Set Theme "dracula"
Set FontSize 14
Set Width 1200
Set Height 800

# Show help
Type "omnexx --help"
Enter
Sleep 1s

# Show version and doctor
Type "omnexx --version"
Enter
Sleep 500ms

Type "omnexx doctor --offline"
Enter
Sleep 1s

# Show init in a temp dir
Type "cd /tmp && mkdir -p omnexx-demo && cd omnexx-demo && git init -q"
Enter
Sleep 500ms

Type "echo 'console.log(\"hello\");' > index.js && echo '{\"scripts\":{\"test\":\"node --test\"}}' > package.json"
Enter
Sleep 500ms

Type "omnexx init --yes"
Enter
Sleep 1s

# Show a plan-only run
Type "omnexx run --plan-only \"Add a test for index.js\""
Enter
Sleep 2s

# Cleanup
Type "cd /tmp && rm -rf omnexx-demo"
Enter
Sleep 500ms