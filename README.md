# Cursor WhatsApp

Follow a Cursor agent on your Mac from WhatsApp, and answer it from your phone.

Cursor sends from a linked WhatsApp account, usually WhatsApp Business. You write from your personal WhatsApp. The thread is a normal two-sided chat: your messages on one side, Cursor on the other. People who message the business number for anything else are ignored.

This is a local macOS tool. It is not part of Cursor or WhatsApp.

## What you get

- A WhatsApp note when a local agent starts.
- A note when that agent finishes, with the project name and whether it completed, stopped, or errored.
- A note when Cursor is waiting for you to approve a command on the Mac.
- A way to send the next instruction from your phone. If an agent is running, your message is delivered when the current turn ends.
- A way to answer when the agent asks you a question through the included `ask` tool.
- `pause` and `resume`, so progress texts can stay quiet while questions still come through.

Messages stay short. File contents, diffs, secrets, email addresses, phone numbers, and long numbers are removed before anything is sent.

## What you can send

Send these from your personal WhatsApp, in the chat with the linked number:

| Message | What happens |
| --- | --- |
| `status` | Link state, whether progress texts are on, and the active project |
| `pause` | Stop progress texts. Questions still arrive |
| `resume` | Turn progress texts back on |
| `sessions` | The few most recent Cursor chats |
| `help` | The short command list |
| anything else | Saved as a follow-up for the current Cursor chat |

`stats` is accepted as `status`.

A follow-up does not type into the open Cursor window immediately. It is sent into that chat when the current turn ends. If Cursor asked a question, your next message is the answer to that question.

Command approvals still happen on the Mac. The phone only tells you that Cursor is waiting.

## Requirements

- macOS
- [Cursor](https://cursor.com) desktop
- Node.js 20 or newer
- A WhatsApp account to link on the Mac, preferably WhatsApp Business
- Your personal WhatsApp, which will talk to that account

The linked account and the phone you type on must be two different WhatsApp numbers. Linking your personal account and messaging yourself is not the setup this uses.

## Install

```bash
git clone https://github.com/israromar/cursor-whatsapp.git
cd cursor-whatsapp
npm install
node src/cli.mjs install
```

`install` does four things:

1. Starts a background service at login.
2. Adds user-level Cursor hooks, so every local project is covered. Nothing is added to a project repository.
3. Adds a Cursor tool named `cursor-whatsapp` with `ask` and `notify`.
4. Opens a QR image at `~/.cursor-whatsapp/qr.png`.

On the phone that owns the Cursor number, open WhatsApp Business, then Settings, Linked devices, Link a device, and scan the QR. The linked device shows up as Mac OS.

Then open your personal WhatsApp and message that business number with the code in `~/.cursor-whatsapp/pair-code`. It looks like `cursor-XXXX`. Cursor replies in that chat. Send `status` to confirm.

Reload Cursor once so it picks up the new tool.

Check the service any time:

```bash
node src/cli.mjs status
```

## How an agent should use it

The hooks already tell a new Cursor chat about the bridge. When the agent needs a decision, it should call `ask` and wait. `notify` is only for a one-line status. Neither tool should receive secrets, patient data, file contents, diffs, or logs. If WhatsApp is unreachable, the agent should ask in the Cursor chat instead.

## Privacy

- The bridge listens on `127.0.0.1` only.
- A random token in `~/.cursor-whatsapp/config.json` guards that local port. The file is readable only by your user.
- The WhatsApp login session stays in `~/.cursor-whatsapp/auth` and is not part of this repository.
- Only the paired personal number can give commands. Other inbound messages are dropped.
- Progress texts are limited so a busy agent cannot flood the chat.

## Limits

- macOS only. The background service is a launch agent.
- User hooks run for local Cursor sessions. They do not run for Cursor cloud agents.
- The phone cannot click an approval dialog on the Mac.
- Ordinary file and shell errors are not forwarded. A permission prompt is.
- When you ask from WhatsApp, that answer is sent back. Other agent replies stay on the Mac.
- `run` can continue an idle chat through the [Cursor agent CLI](https://cursor.com/docs/cli/overview) when that CLI is installed. It does not skip command approvals.
- This uses WhatsApp's linked-device connection. It is not the WhatsApp Business Cloud API. WhatsApp can disconnect linked devices, and using an unofficial client can violate WhatsApp's terms.

## Uninstall

```bash
node src/cli.mjs unlink
node src/cli.mjs uninstall
```

`unlink` logs the linked device out and opens a new QR. `uninstall` removes the Cursor hooks, the Cursor tool, and the login item. Session files remain in `~/.cursor-whatsapp` until you delete that folder.

## Development

```bash
npm test
```

## License

[MIT](LICENSE)
