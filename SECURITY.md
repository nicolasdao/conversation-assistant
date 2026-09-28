# Security

## Reporting a vulnerability

Please report security issues privately, never in a public issue:

- **GitHub:** the repository's **Security** tab → **Report a vulnerability** (private vulnerability reporting), or
- **Email:** nic@cloudlesslabs.com, with "Conversation Assistant security" in the subject.

Include what you found, how to reproduce it, and the version (**Conversation Assistant → About Conversation Assistant** shows it; in a browser, the settings menu). You will get a reply within a week. Please give us a reasonable time to ship a fix before you disclose it.

Only the latest release is supported: fixes ship as a new version, which installed apps download by themselves.

**In scope:** the Mac app, the engine (`src/`), the web page (`web/`), the capture helper (`native/capture/`), and how releases are built and published. **Out of scope:** the services the app calls (OpenAI, OpenRouter), which have their own programmes.

## Checking that a download is genuine

The only official downloads are this repository's [Releases](https://github.com/nicolasdao/conversation-assistant/releases). A genuine app:

- is signed by **Developer ID Application: Nicolas Dao (UX774V7BK2)** and notarized by Apple. To check an installed copy:

  ```bash
  codesign -dv "/Applications/Conversation Assistant.app" 2>&1 | grep TeamIdentifier   # TeamIdentifier=UX774V7BK2
  spctl --assess -vv "/Applications/Conversation Assistant.app"                        # source=Notarized Developer ID
  ```

- matches the SHA-256 checksum in its release notes: `shasum -a 256 Conversation-Assistant-<version>-arm64.dmg`.

A copy from anywhere else, or signed by anyone else, is not ours, even if it has the same name.

## How the app protects you

- **Your keys stay on your Mac.** The OpenAI and OpenRouter keys are saved in `~/Library/Application Support/Conversation Assistant/credentials.json`, readable only by your macOS user, and sent only to OpenAI and OpenRouter. They never appear in logs, recordings, or exports, and never reach the project's authors.
- **Nothing listens on the network.** The Mac app opens no port: its window talks to the engine inside the app. Other programs and websites cannot reach it.
- **Its permissions cannot be borrowed.** The app is built so that no other program can run code with its Microphone and System Audio Recording permissions: it cannot be relaunched as plain Node, with `NODE_OPTIONS`, `--inspect`, or a remote debugging port, and it checks that its own code is the code that was signed.
- **Updates come only from this repository**, and macOS installs one only if it is signed by the same developer. Published releases cannot be altered afterwards.

Details: [docs/desktop.md](docs/desktop.md) and [docs/setup.md](docs/setup.md).
