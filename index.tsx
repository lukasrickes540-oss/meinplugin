import { sendBotMessage } from "@api/Commands";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, RestAPI, useEffect, useState } from "@webpack/common";

// Bei jedem neuen Release erhöhen (z. B. "1.0.1"), sonst erkennt das Auto-Update nichts Neues
const VERSION = "1.0.1";

const Native = VencordNative.pluginHelpers.MeinPlugin as PluginNative<typeof import("./native")>;

/* ------------------------------ Einstellungen ------------------------------ */

const settings = definePluginSettings({
    versteckt: {
        type: OptionType.BOOLEAN,
        description: "Versteckt-Modus: Deine Nachrichten sind für andere unsichtbar (mit !op umschalten)",
        default: true
    },
    passwort: {
        type: OptionType.STRING,
        description: "Gemeinsames Passwort. Nur wer dasselbe Passwort + das Plugin hat, kann mitlesen.",
        default: "bitte-aendern"
    },
    tarntext: {
        type: OptionType.STRING,
        description: "Text, den Leute OHNE Plugin stattdessen sehen",
        default: "."
    },
    einladungStunden: {
        type: OptionType.NUMBER,
        description: "Gültigkeit des !gg-Links in Stunden (0 = unbegrenzt)",
        default: 24
    },
    willkommenKanalId: {
        type: OptionType.STRING,
        description: "Kanal-ID für die Willkommensnachricht (leer = aus)",
        default: ""
    },
    willkommenText: {
        type: OptionType.STRING,
        description: "Willkommensnachricht. {user} wird zur Erwähnung des neuen Mitglieds.",
        default: "Willkommen {user} auf dem Server! 🎉"
    },
    hintergrundAktiv: {
        type: OptionType.BOOLEAN,
        description: "Eigenen Hintergrund verwenden",
        default: false,
        onChange: () => aktualisiereHintergrund()
    },
    hintergrundUrl: {
        type: OptionType.STRING,
        description: "Bild-Link für den Hintergrund (direkter https://-Link zu einem Bild)",
        default: "",
        onChange: () => aktualisiereHintergrund()
    },
    abdunklung: {
        type: OptionType.SLIDER,
        description: "Abdunklung der Oberfläche in % (höher = Text besser lesbar)",
        markers: [0, 25, 50, 75, 100],
        default: 50,
        stickToMarkers: false,
        onChange: () => aktualisiereHintergrund()
    },
    unschaerfe: {
        type: OptionType.SLIDER,
        description: "Unschärfe des Hintergrundbilds in Pixeln",
        markers: [0, 5, 10, 15, 20],
        default: 0,
        stickToMarkers: false,
        onChange: () => aktualisiereHintergrund()
    },
    updateUrl: {
        type: OptionType.STRING,
        description: "Update-Link: Raw-Link zur index.tsx auf GitHub (leer = Updates aus)",
        default: ""
    },
    vencordPfad: {
        type: OptionType.STRING,
        description: "Pfad zu deinem Vencord-Ordner (dort wird nach dem Update gebaut)",
        default: "C:\\Users\\lukas\\Vencord"
    },
    autoUpdate: {
        type: OptionType.BOOLEAN,
        description: "Updates automatisch installieren (aus = nur Hinweis, dann mit !update installieren)",
        default: true
    },
    updateIntervallStunden: {
        type: OptionType.NUMBER,
        description: "Wie oft auf Updates geprüft wird (in Stunden)",
        default: 6
    }
});

/* --------------------- Verschlüsselung + unsichtbare Zeichen --------------------- */

const CHARS = ["\u200B", "\u200C", "\u200D", "\u2060"]; // je 2 Bit
const PAYLOAD_RE = /[\u200B\u200C\u200D\u2060]{16,}/;
const enc = new TextEncoder();
const dec = new TextDecoder();

let keyCache: { pw: string; key: CryptoKey; } | null = null;

async function getKey(): Promise<CryptoKey> {
    const pw = settings.store.passwort;
    if (keyCache?.pw === pw) return keyCache.key;

    const base = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("MeinPlugin-v1"), iterations: 100000, hash: "SHA-256" },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
    keyCache = { pw, key };
    return key;
}

function bytesToInvisible(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) {
        out += CHARS[(b >> 6) & 3] + CHARS[(b >> 4) & 3] + CHARS[(b >> 2) & 3] + CHARS[b & 3];
    }
    return out;
}

function invisibleToBytes(s: string): Uint8Array {
    const out = new Uint8Array(Math.floor(s.length / 4));
    for (let i = 0; i < out.length; i++) {
        let v = 0;
        for (let j = 0; j < 4; j++) v = (v << 2) | CHARS.indexOf(s[i * 4 + j]);
        out[i] = v;
    }
    return out;
}

async function verstecken(text: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getKey(), enc.encode(text)));
    const payload = new Uint8Array(iv.length + ct.length);
    payload.set(iv, 0);
    payload.set(ct, iv.length);
    return (settings.store.tarntext || ".") + bytesToInvisible(payload);
}

/** null = keine versteckte Nachricht, "" = vorhanden aber nicht entschlüsselbar */
async function aufdecken(content: string): Promise<string | null> {
    const match = PAYLOAD_RE.exec(content ?? "");
    if (!match) return null;
    try {
        const bytes = invisibleToBytes(match[0]);
        const iv = bytes.slice(0, 12);
        const ct = bytes.slice(12);
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await getKey(), ct);
        return dec.decode(plain);
    } catch {
        return "";
    }
}

/* ------------------------------- Anzeige im Chat ------------------------------- */

function Aufgedeckt({ message }: { message: { content: string; }; }) {
    const [text, setText] = useState<string | null>(null);

    useEffect(() => {
        let aktiv = true;
        aufdecken(message.content).then(t => aktiv && setText(t));
        return () => { aktiv = false; };
    }, [message.content]);

    if (text === null) return null;

    return (
        <div style={{ marginTop: 4, fontSize: "0.9em", opacity: 0.95 }}>
            {text === "" ? "🔒 Versteckte Nachricht (falsches Passwort?)" : `🔓 ${text}`}
        </div>
    );
}

/* ---------------------------------- Befehle ---------------------------------- */

const CMD_RE = /^!(gg|op|softban|update|version)\b\s*(.*)$/is;
const uebersprungen = new Set<string>();

const info = (channelId: string, content: string) => sendBotMessage(channelId, { content });

function fehlerText(e: any): string {
    return e?.body?.message ?? e?.message ?? String(e);
}

async function befehl(cmd: string, arg: string, channelId: string) {
    const guildId = ChannelStore.getChannel(channelId)?.guild_id;

    switch (cmd) {
        case "gg": {
            const stunden = Number(settings.store.einladungStunden) || 0;
            const res = await RestAPI.post({
                url: `/channels/${channelId}/invites`,
                body: { max_age: stunden * 3600, max_uses: 0, unique: true }
            });
            const link = `https://discord.gg/${res.body.code}`;
            navigator.clipboard.writeText(link).catch(() => { });
            info(channelId, `🔗 Einladung (in die Zwischenablage kopiert): ${link}`);
            break;
        }

        case "softban": {
            if (!guildId) throw new Error("Nur auf Servern möglich.");
            const id = arg.split(/\s+/)[0];
            if (!/^\d{17,20}$/.test(id)) throw new Error("Nutzung: !softban <Nutzer-ID>");

            // Bannen (löscht Nachrichten der letzten 7 Tage) und direkt wieder entbannen
            await RestAPI.put({ url: `/guilds/${guildId}/bans/${id}`, body: { delete_message_seconds: 604800 } });
            await RestAPI.delete({ url: `/guilds/${guildId}/bans/${id}` });
            info(channelId, `🔨 Softban für <@${id}> durchgeführt (Nachrichten der letzten 7 Tage gelöscht, Nutzer kann wieder beitreten).`);
            break;
        }

        case "update": {
            // Nicht abwarten, sonst blockiert der Build das Chatfeld
            void updatePruefen(true, channelId);
            break;
        }

        case "version": {
            info(channelId, `ℹ️ MeinPlugin Version ${VERSION}`);
            break;
        }

        case "op": {
            settings.store.versteckt = !settings.store.versteckt;
            info(channelId, settings.store.versteckt
                ? "🕶️ Versteckt-Modus AN: Nur Leute mit Plugin + Passwort sehen deine Nachrichten."
                : "👁️ !op aktiv: Deine Nachrichten sind jetzt für alle normal sichtbar.");
            break;
        }
    }
}

const preSend: MessageSendListener = async (channelId, msg) => {
    if (uebersprungen.delete(msg.content)) return;

    const text = msg.content.trim();

    const m = CMD_RE.exec(text);
    if (m) {
        try {
            await befehl(m[1].toLowerCase(), m[2].trim(), channelId);
        } catch (e) {
            info(channelId, `❌ Fehler: ${fehlerText(e)}`);
        }
        return { cancel: true };
    }

    if (!settings.store.versteckt || !text) return;

    const versteckt = await verstecken(text);
    if (versteckt.length > 2000) {
        info(channelId, "❌ Nachricht zu lang für den Versteckt-Modus (max. ca. 450 Zeichen). Kürzen oder !op nutzen.");
        return { cancel: true };
    }
    msg.content = versteckt;
};

/* ------------------------------ Willkommensnachricht ------------------------------ */

function onMemberAdd({ guildId, user }: { guildId: string; user: { id: string; }; }) {
    const kanalId = settings.store.willkommenKanalId?.trim();
    if (!kanalId) return;

    const kanal = ChannelStore.getChannel(kanalId);
    if (!kanal || kanal.guild_id !== guildId) return;

    const content = settings.store.willkommenText.replaceAll("{user}", `<@${user.id}>`);
    uebersprungen.add(content); // nicht verschlüsseln
    sendMessage(kanalId, { content });
}

/* ------------------------------- Eigener Hintergrund ------------------------------- */

let hintergrundStyle: HTMLStyleElement | null = null;

function hintergrundEntfernen() {
    hintergrundStyle?.remove();
    hintergrundStyle = null;
}

function aktualisiereHintergrund() {
    hintergrundEntfernen();

    const { hintergrundAktiv, hintergrundUrl, abdunklung, unschaerfe } = settings.store;
    const url = (hintergrundUrl ?? "").trim();

    // Nur sichere https-Links zulassen (verhindert kaputtes CSS)
    if (!hintergrundAktiv || !/^https:\/\/[^\s"'()\\]+$/.test(url)) return;

    const alpha = Math.min(100, Math.max(0, Number(abdunklung))) / 100;
    const blur = Math.min(20, Math.max(0, Number(unschaerfe)));
    const flaeche = `rgba(10, 10, 14, ${alpha}) !important`;

    hintergrundStyle = document.createElement("style");
    hintergrundStyle.id = "meinPlugin-hintergrund";
    hintergrundStyle.textContent = `
        html { background: #000 !important; }
        body, #app-mount { background: transparent !important; }

        body::before {
            content: "";
            position: fixed;
            inset: -${blur * 2}px;
            z-index: -1;
            pointer-events: none;
            background: url("${url}") center / cover no-repeat;
            filter: blur(${blur}px);
        }

        :root, .theme-dark, .theme-light, .theme-darker, .theme-midnight {
            --background-primary: ${flaeche};
            --background-secondary: ${flaeche};
            --background-secondary-alt: ${flaeche};
            --background-tertiary: ${flaeche};
            --chat-background: ${flaeche};
            --bg-base-primary: ${flaeche};
            --bg-base-secondary: ${flaeche};
            --bg-base-tertiary: ${flaeche};
            --background-base-low: ${flaeche};
            --background-base-lower: ${flaeche};
            --background-base-lowest: ${flaeche};
            --chat-background-default: ${flaeche};
        }
    `;
    document.head.append(hintergrundStyle);
}

/* ------------------------------------ Auto-Update ------------------------------------ */

let updateLaeuft = false;
let startTimer: ReturnType<typeof setTimeout> | null = null;
let intervallTimer: ReturnType<typeof setInterval> | null = null;

async function updatePruefen(manuell = false, channelId?: string) {
    const sag = (text: string) => { if (channelId) info(channelId, text); };

    const url = (settings.store.updateUrl ?? "").trim();
    if (!url) {
        sag("ℹ️ Kein Update-Link eingestellt (Plugin-Einstellungen → Update-Link).");
        return;
    }
    if (updateLaeuft) {
        sag("⏳ Es läuft bereits eine Update-Prüfung.");
        return;
    }

    updateLaeuft = true;
    try {
        const check = await Native.pruefeUpdate(url, VERSION);
        if (!check.ok) throw new Error(check.fehler);

        if (!check.neu) {
            sag(`✅ Du hast die neueste Version (v${VERSION}).`);
            return;
        }

        // Automatisches Prüfen ohne Auto-Install: nur Hinweis anzeigen
        if (!manuell && !settings.store.autoUpdate) {
            showNotification({
                title: "MeinPlugin: Update verfügbar",
                body: `Version ${check.version} ist da. Schreibe !update zum Installieren.`
            });
            return;
        }

        sag(`⬇️ Lade Update v${check.version} und baue Vencord neu … (kann eine Minute dauern)`);

        const res = await Native.installiereUpdate(url, (settings.store.vencordPfad ?? "").trim(), VERSION);
        if (!res.ok) throw new Error(res.fehler);

        sag(`✅ Update auf v${res.version} installiert. Drücke Strg+R, um es zu laden.`);
        showNotification({
            title: "MeinPlugin aktualisiert",
            body: `Version ${res.version} ist installiert. Drücke Strg+R zum Neuladen.`
        });
    } catch (e) {
        sag(`❌ Update fehlgeschlagen: ${fehlerText(e)}`);
        if (!manuell) {
            console.error("[MeinPlugin] Update fehlgeschlagen:", e);
            showNotification({ title: "MeinPlugin: Update fehlgeschlagen", body: fehlerText(e) });
        }
    } finally {
        updateLaeuft = false;
    }
}

function updateTimerStarten() {
    updateTimerStoppen();

    const stunden = Math.max(1, Number(settings.store.updateIntervallStunden) || 6);
    startTimer = setTimeout(() => void updatePruefen(), 15_000);
    intervallTimer = setInterval(() => void updatePruefen(), stunden * 3_600_000);
}

function updateTimerStoppen() {
    if (startTimer) clearTimeout(startTimer);
    if (intervallTimer) clearInterval(intervallTimer);
    startTimer = null;
    intervallTimer = null;
}

/* ----------------------------------- Plugin ----------------------------------- */

export default definePlugin({
    name: "MeinPlugin",
    description: "!gg (Einladung), !softban <ID>, !op, Willkommensnachricht und versteckter Chat für Plugin-Nutzer",
    authors: [{ name: "Du", id: 0n }],
    settings,

    start() {
        addMessagePreSendListener(preSend);
        addMessageAccessory("MeinPluginAufdecken", props => <Aufgedeckt message={props.message} />);
        FluxDispatcher.subscribe("GUILD_MEMBER_ADD", onMemberAdd);
        aktualisiereHintergrund();
        updateTimerStarten();
    },

    stop() {
        removeMessagePreSendListener(preSend);
        removeMessageAccessory("MeinPluginAufdecken");
        FluxDispatcher.unsubscribe("GUILD_MEMBER_ADD", onMemberAdd);
        hintergrundEntfernen();
        updateTimerStoppen();
    }
});
