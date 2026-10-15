# TempChat 2.0

A temporary, real-time chat app built with Node.js, Express, Socket.IO and a glassmorphism frontend.

## Features

- Create and join rooms with 6-character codes
- Live online-member list
- Messages automatically expire (default: 10 minutes)
- Image and file sharing (default upload cap: 8 MB)
- Emoji reactions
- Clear-room button
- Mobile-friendly glassmorphism UI
- No account or database required for the starter version

## Requirements

- Node.js 18 or newer
- npm

## Run locally

1. Extract the project ZIP.
2. Open a terminal in the `tempchat-2` folder.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the server:

   ```bash
   npm start
   ```

5. Open `http://localhost:3000`.

To test with another device on the same Wi-Fi, open `http://YOUR-COMPUTER-LAN-IP:3000` on that device. Allow Node.js through your local firewall if prompted.

## Configuration

Copy `.env.example` to `.env` and edit the values if your host supports environment files. The app does not load `.env` automatically, so either set environment variables in your hosting dashboard or install `dotenv` and add `require("dotenv").config()` as the first line of `server.js`.

- `PORT`: port to listen on (default `3000`)
- `MESSAGE_TTL_SECONDS`: message lifetime, 60–86400 seconds (default `600`)
- `MAX_UPLOAD_MB`: file upload limit, 1–20 MB (default `8`)
- `MAX_ROOM_MEMBERS`: maximum users per room, 2–100 (default `30`)

## Deployment

Deploy on a Node.js host or VPS that supports long-lived WebSocket connections and writable local disk.

1. Upload/extract the project.
2. Use Node.js 18+.
3. Run `npm install`.
4. Set the environment variables in the host dashboard (do not upload secrets).
5. Set the start command to `npm start`.
6. Expose the port assigned by the host. The app reads `PORT`.
7. Test `/health`, then create a room and test from a second browser/device.

For a public deployment, use HTTPS. Socket.IO will use secure WebSockets automatically when the site is served over HTTPS.

## Important limitations

This starter version stores rooms/messages in server memory and attachments on local disk:

- A server restart clears messages and rooms; startup cleanup also removes old uploaded files.
- Rooms and uploads are not shared across multiple server instances.
- A server with ephemeral disk may remove uploads during redeploy/restart.
- The room code is an invite code, not end-to-end encryption. Anyone with the code can join while the room exists.
- Users can take screenshots or copy content; auto-delete is not a guarantee that nobody retained it.
- The `Clear room messages` button is available to any room member in this starter build.
- For a production app, add room-owner permissions, upload scanning, stronger rate limiting, durable storage with expiry jobs, and privacy/abuse reporting.

## File types

The server accepts JPEG, PNG, GIF, WebP, PDF, TXT, ZIP, DOCX and XLSX. Maximum upload size is configured by `MAX_UPLOAD_MB`. SVG and executable files are not accepted.

## Troubleshooting

- **`npm` is not recognized:** install Node.js 18+ and reopen the terminal.
- **Port already in use:** set `PORT=3001` and restart.
- **Socket stuck on reconnecting:** ensure your host supports WebSockets and serves the frontend and `/socket.io/` from the same origin.
- **File upload fails:** check file type and upload-size settings, and ensure the `uploads/` directory is writable.
