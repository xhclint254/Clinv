import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser } from '@whiskeysockets/baileys';

const router = express.Router();

// Session storage in memory (replace with database for production)
const sessionStore = new Map();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    let dirs = './' + (num.replace(/[^0-9]/g, '') || `session`);
    
    // Remove existing session if present
    await removeFile(dirs);
    
    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            let socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: ["Toxic-MD", "Chrome", "20.0.04"],
            });

            if (!socket.authState.creds.registered) {
                await delay(2000);
                num = num.replace(/[^0-9]/g, '');
                const code = await socket.requestPairingCode(num);
                if (!res.headersSent) {
                    await res.send({ code });
                }
            }

            socket.ev.on('creds.update', saveCreds);
            socket.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;

                if (connection === "open") {
                    await delay(10000);
                    const sessionData = fs.readFileSync(dirs + '/creds.json', 'utf-8');
                    
                    // Convert session data to Base64
                    const base64Session = Buffer.from(sessionData).toString('base64');
                    
                    // Store session data
                    sessionStore.set(num, base64Session);

                    // Send the session data to the user
                    const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                    await socket.sendMessage(userJid, { 
                        text: `🔐 Your Toxic-MD Session Data:\n\n${base64Session}\n\n` +
                              `Keep this safe! Use it to restore your session.`
                    });

                    // Send welcome message
                    await socket.sendMessage(userJid, { 
                        text: '🚀 Thank you for choosing Toxic-MD by 𝐱𝐡_𝐜𝐥𝐢𝐧𝐭𝐨𝐧!\n\n' +
                              'Use /restore with your session data to reconnect later.'
                    });

                    // Clean up
                    await delay(100);
                    removeFile(dirs);
                    socket.end();
                    
                    // Also send the session data in the HTTP response if still open
                    if (!res.headersSent) {
                        res.send({ session: base64Session });
                    }
                } else if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
                    console.log('Connection closed unexpectedly:', lastDisconnect.error);
                    await delay(10000);
                    initiateSession();
                }
            });
        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).send({ error: 'Failed to create session', details: err.message });
            }
        }
    }

    await initiateSession();
});

// Session restoration endpoint
router.post('/restore', async (req, res) => {
    const { sessionData, number } = req.body;
    
    if (!sessionData || !number) {
        return res.status(400).send({ error: 'Both sessionData and number are required' });
    }

    try {
        // Convert base64 back to JSON
        const sessionJson = Buffer.from(sessionData, 'base64').toString('utf-8');
        const sessionDir = `./restored_${number}`;
        
        // Ensure directory exists
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir);
        }
        
        // Write the creds file
        fs.writeFileSync(`${sessionDir}/creds.json`, sessionJson);
        
        res.send({ 
            status: 'Session restored successfully',
            directory: sessionDir
        });
    } catch (err) {
        console.error('Error restoring session:', err);
        res.status(500).send({ error: 'Failed to restore session', details: err.message });
    }
});

// Error handlers
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});

export default router;