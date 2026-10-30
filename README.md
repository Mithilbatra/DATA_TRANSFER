# Data Transfer

Send files of any type between two laptops on the same Wi-Fi using a short code. No install beyond Node.js 20+.

1. On **both** laptops: `node server.js`, then open http://localhost:3000
2. On the sending laptop, drop files into **Send**. A code like `42-381920` appears.
3. On the receiving laptop, type the code into **Receive** (the dash is optional), pick the files you want, and download.

The first part of the code is the sender's place on your network (`42` for `192.168.1.42`). The receiver sends the code only to that address instead of the whole network, so check the first part when you type it. The last 6 digits are the secret.

Codes expire 15 minutes after the last file was added, or when the sender stops the server. Shared files are copied to a temp folder (so you need that much free disk space), which is deleted on exit. If the app is killed hard or crashes, delete the leftover `data-transfer-*` folders in your temp folder yourself.

**If the receiver can't find the sender:** allow Node through the firewall (TCP 3000). If either laptop is on a VPN, the code can point at the wrong network: open "Sender not found?" and type the address shown under the sender's code. If several addresses are shown (VPN, Docker, WSL), try each one. Guest or office Wi-Fi that blocks device-to-device traffic won't work at all.

**"Too many wrong codes, wait a minute":** to stop guessing, the sender refuses everyone for a minute after 20 wrong codes from the whole network. Someone on the Wi-Fi can abuse this to block downloads; if it keeps happening, the network isn't one to use this on.

Change the port with `PORT=4000 node server.js`. Use the same port on both laptops, or type the sender's address with its port under "Sender not found?". Run the self-check with `npm test`.

Transfers are plain HTTP on your local network, protected only by the short-lived code. Don't use it on networks you don't trust.
