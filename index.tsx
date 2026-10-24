import { sendBotMessage } from "@api/Commands";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, RestAPI, useEffect, UserStore, useState } from "@webpack/common";

// Bei jedem neuen Release erhöhen (z. B. "1.0.1"), sonst erkennt das Auto-Update nichts Neues
const VERSION = "1.0.5";

const Native = VencordNative.pluginHelpers.MeinPlugin as PluginNative<typeof import("./native")>;

// Torwächter: Diese Standardwerte bekommen alle, die das Plugin von dir erhalten.
// Trage hier die IDs ein, die dir !serversetup ausgibt, BEVOR du die Datei auf GitHub hochlädst.
const TOR_STANDARD = {
    serverId: "", // ID deines Discord-Servers
    kanalId: "",  // ID des Verify-Kanals
    rolleId: ""   // ID der Rolle "Verifiziert"
};

// Eigene Einstellungen (von !serversetup automatisch gesetzt) haben Vorrang vor den Standardwerten
const TOR = {
    get serverId(): string { return settings.store.torServerId || TOR_STANDARD.serverId; },
    get kanalId(): string { return settings.store.torKanalId || TOR_STANDARD.kanalId; },
    get rolleId(): string { return settings.store.torRolleId || TOR_STANDARD.rolleId; }
};

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
    },
    torGeheimnis: {
        type: OptionType.STRING,
        description: "Torwächter-Geheimnis: Gemeinsames Geheimwort. Alle, die auf den Server sollen, brauchen dasselbe.",
        default: ""
    },
    torwaechter: {
        type: OptionType.BOOLEAN,
        description: "Torwächter-Prüfer: Neue Mitglieder automatisch freischalten (nur für dich als Server-Besitzer, Discord muss offen sein)",
        default: false
    },
    torServerId: {
        type: OptionType.STRING,
        description: "Torwächter: Server-ID (wird von !serversetup automatisch gesetzt)",
        default: ""
    },
    torKanalId: {
        type: OptionType.STRING,
        description: "Torwächter: Verify-Kanal-ID (wird von !serversetup automatisch gesetzt)",
        default: ""
    },
    torRolleId: {
        type: OptionType.STRING,
        description: "Torwächter: Rollen-ID von „Verifiziert“ (wird von !serversetup automatisch gesetzt)",
        default: ""
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

const CMD_RE = /^!(gg|op|softban|update|version|kick|ban|unban|mute|unmute|purge|avatar|invites|hilfe|verify|serversetup)\b\s*(.*)$/is;
const uebersprungen = new Set<string>();

const info = (channelId: string, content: string) => sendBotMessage(channelId, { content });

function fehlerText(e: any): string {
    return e?.body?.message ?? e?.message ?? String(e);
}

/** Akzeptiert eine Nutzer-ID oder eine Erwähnung (<@123...>) als erstes Wort */
function nutzerId(text: string): string {
    const token = (text ?? "").trim().split(/\s+/)[0] ?? "";
    const m = /^<@!?(\d{17,20})>$/.exec(token) ?? /^(\d{17,20})$/.exec(token);
    if (!m) throw new Error("Bitte eine gültige Nutzer-ID oder Erwähnung angeben.");
    return m[1];
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
            const id = nutzerId(arg);

            // Bannen (löscht Nachrichten der letzten 7 Tage) und direkt wieder entbannen
            await RestAPI.put({ url: `/guilds/${guildId}/bans/${id}`, body: { delete_message_seconds: 604800 } });
            await RestAPI.delete({ url: `/guilds/${guildId}/bans/${id}` });
            info(channelId, `🔨 Softban für <@${id}> durchgeführt (Nachrichten der letzten 7 Tage gelöscht, Nutzer kann wieder beitreten).`);
            break;
        }

        case "kick": {
            if (!guildId) throw new Error("Nur auf Servern möglich.");
            const id = nutzerId(arg);
            await RestAPI.delete({ url: `/guilds/${guildId}/members/${id}` });
            info(channelId, `👢 <@${id}> wurde gekickt.`);
            break;
        }

        case "ban": {
            if (!guildId) throw new Error("Nur auf Servern möglich.");
            const id = nutzerId(arg);
            await RestAPI.put({ url: `/guilds/${guildId}/bans/${id}`, body: { delete_message_seconds: 0 } });
            info(channelId, `⛔ <@${id}> wurde gebannt.`);
            break;
        }

        case "unban": {
            if (!guildId) throw new Error("Nur auf Servern möglich.");
            const id = nutzerId(arg);
            await RestAPI.delete({ url: `/guilds/${guildId}/bans/${id}` });
            info(channelId, `✅ <@${id}> wurde entbannt.`);
            break;
        }

        case "mute": {
            if (!guildId) throw new Error("Nur auf Servern möglich.");
            const [idText, minText] = arg.split(/\s+/);
            const id = nutzerId(idText);
            const minuten = Math.floor(Number(minText));
            if (!Number.isFinite(minuten) || minuten < 1 || minuten > 40320) {
                throw new Error("Nutzung: !mute <ID> <Minuten, 1 bis 40320>");
            }
            await RestAPI.patch({
                url: `/guilds/${guildId}/members/${id}`,
                body: { communication_disabled_until: new Date(Date.now() + minuten * 60_000).toISOString() }
            });
            info(channelId, `🔇 <@${id}> ist für ${minuten} Minuten stummgeschaltet.`);
            break;
        }

        case "unmute": {
            if (!guildId) throw new Error("Nur auf Servern möglich.");
            const id = nutzerId(arg);
            await RestAPI.patch({
                url: `/guilds/${guildId}/members/${id}`,
                body: { communication_disabled_until: null }
            });
            info(channelId, `🔊 <@${id}> ist nicht mehr stummgeschaltet.`);
            break;
        }

        case "purge": {
            const anzahl = Math.floor(Number(arg.split(/\s+/)[0]));
            if (!Number.isFinite(anzahl) || anzahl < 1 || anzahl > 100) {
                throw new Error("Nutzung: !purge <Anzahl, 1 bis 100>");
            }
            const res = await RestAPI.get({ url: `/channels/${channelId}/messages`, query: { limit: anzahl } });
            // Discord erlaubt Massenlöschen nur für Nachrichten der letzten 14 Tage
            const grenze = Date.now() - 13 * 24 * 3_600_000;
            const ids: string[] = res.body
                .filter((m: any) => new Date(m.timestamp).getTime() > grenze)
                .map((m: any) => m.id);

            if (!ids.length) throw new Error("Keine löschbaren Nachrichten gefunden (nur die letzten 13 Tage).");

            if (ids.length === 1) {
                await RestAPI.delete({ url: `/channels/${channelId}/messages/${ids[0]}` });
            } else {
                await RestAPI.post({ url: `/channels/${channelId}/messages/bulk-delete`, body: { messages: ids } });
            }
            info(channelId, `🧹 ${ids.length} Nachrichten gelöscht.`);
            break;
        }

        case "avatar": {
            const id = arg.trim() ? nutzerId(arg) : UserStore.getCurrentUser().id;
            const res = await RestAPI.get({ url: `/users/${id}` });
            const u = res.body;
            const bild = u.avatar
                ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=1024`
                : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
            info(channelId, `🖼️ Profilbild von ${u.username}:\n${bild}`);
            break;
        }

        case "invites": {
            if (!guildId) throw new Error("Nur auf Servern möglich.");
            const res = await RestAPI.get({ url: `/guilds/${guildId}/invites` });
            const liste: string[] = res.body.slice(0, 15).map((i: any) =>
                `• discord.gg/${i.code} (${i.uses}${i.max_uses ? `/${i.max_uses}` : ""} Nutzungen${i.inviter ? `, von ${i.inviter.username}` : ""})`
            );
            info(channelId, liste.length
                ? `📨 Aktive Einladungen (${res.body.length}):\n${liste.join("\n")}`
                : "📨 Es gibt keine aktiven Einladungen.");
            break;
        }

        case "serversetup": {
            // Nicht abwarten, sonst blockiert es das Chatfeld
            void serverErstellen(arg.trim().slice(0, 100) || "Mein Server", channelId);
            break;
        }

        case "verify": {
            if (!torKonfiguriert()) throw new Error("Torwächter ist nicht eingerichtet (IDs im Code und Geheimnis in den Einstellungen).");
            letzterHandshake = 0;
            await handshakeSenden();
            info(channelId, "🛂 Nachweis an den Verify-Kanal gesendet. Wenn der Server-Besitzer online ist, wirst du gleich freigeschaltet.");
            break;
        }

        case "hilfe": {
            info(channelId, [
                "📖 **Befehle**",
                "`!gg` Einladungslink erstellen",
                "`!invites` aktive Einladungen anzeigen",
                "`!kick <ID>` Nutzer kicken",
                "`!ban <ID>` / `!unban <ID>` bannen / entbannen",
                "`!softban <ID>` bannen und sofort entbannen (löscht Nachrichten)",
                "`!mute <ID> <Minuten>` / `!unmute <ID>` Timeout setzen / aufheben",
                "`!purge <Anzahl>` letzte Nachrichten im Kanal löschen",
                "`!avatar [ID]` Profilbild anzeigen",
                "`!op` Versteckt-Modus umschalten",
                "`!verify` Torwächter-Nachweis erneut senden",
                "`!serversetup <Name>` kompletten Server mit Rollen, Kanälen und Torwächter erstellen",
                "`!update` / `!version` Plugin aktualisieren / Version zeigen"
            ].join("\n"));
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

/* ------------------------------ Server automatisch erstellen ------------------------------ */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const BIT = (n: number) => 1n << BigInt(n);

// Rechte (Discord-Bitwerte)
const RECHTE_BASIS = BIT(6) | BIT(10) | BIT(11) | BIT(14) | BIT(15) | BIT(16) | BIT(18) | BIT(20)
    | BIT(21) | BIT(25) | BIT(26) | BIT(31) | BIT(35);
const RECHTE_MOD = RECHTE_BASIS | BIT(1) | BIT(2) | BIT(7) | BIT(13) | BIT(22) | BIT(23) | BIT(24)
    | BIT(27) | BIT(34) | BIT(40);
const RECHTE_ADMIN = BIT(3);
const RECHTE_VERIFY = BIT(10) | BIT(11) | BIT(16);

const overwrite = (id: string, allow: bigint, deny: bigint) =>
    ({ id, type: 0, allow: allow.toString(), deny: deny.toString() });

function zufallsGeheimnis(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return Array.from(bytes, b => b.toString(36).padStart(2, "0")).join("");
}

async function serverErstellen(name: string, channelId: string) {
    const sag = (text: string) => info(channelId, text);
    const post = async (url: string, body: any) => {
        await sleep(400); // Pausen gegen Rate-Limits
        return (await RestAPI.post({ url, body })).body;
    };

    try {
        sag(`🏗️ Erstelle den Server „${name}“ … das dauert etwa 30 Sekunden.`);

        const guild = await post("/guilds", { name, icon: null });
        const gid: string = guild.id;

        // Rollen (zuerst Admin, dann Moderator, dann Verifiziert)
        const admin = await post(`/guilds/${gid}/roles`, { name: "Admin", permissions: RECHTE_ADMIN.toString(), color: 0xE74C3C, hoist: true });
        const mod = await post(`/guilds/${gid}/roles`, { name: "Moderator", permissions: RECHTE_MOD.toString(), color: 0x3498DB, hoist: true });
        const verifiziert = await post(`/guilds/${gid}/roles`, { name: "Verifiziert", permissions: RECHTE_BASIS.toString(), color: 0x2ECC71 });

        // @everyone darf nichts sehen, nur der Verify-Kanal wird freigegeben
        await sleep(400);
        await RestAPI.patch({ url: `/guilds/${gid}/roles/${gid}`, body: { permissions: "0" } });

        // Reihenfolge der Rollen festlegen (Admin oben)
        await sleep(400);
        await RestAPI.patch({
            url: `/guilds/${gid}/roles`,
            body: [
                { id: admin.id, position: 3 },
                { id: mod.id, position: 2 },
                { id: verifiziert.id, position: 1 }
            ]
        }).catch(() => { });

        // Kanäle
        const neu = new Set<string>();
        const anlegen = async (kanalName: string, type: number, parent?: string, overwrites?: any[]): Promise<string> => {
            const c = await post(`/guilds/${gid}/channels`, {
                name: kanalName,
                type,
                parent_id: parent,
                permission_overwrites: overwrites
            });
            neu.add(c.id);
            return c.id;
        };

        const katZugang = await anlegen("Zugang", 4);
        const verifyId = await anlegen("verify", 0, katZugang, [
            overwrite(gid, RECHTE_VERIFY, 0n),       // alle dürfen hier sehen und schreiben
            overwrite(verifiziert.id, 0n, BIT(10))   // nach der Freischaltung wird der Kanal ausgeblendet
        ]);

        const katChat = await anlegen("Chat", 4);
        const allgemeinId = await anlegen("allgemein", 0, katChat);
        await anlegen("befehle", 0, katChat);

        const katSprache = await anlegen("Sprache", 4);
        await anlegen("Allgemein", 2, katSprache);
        await anlegen("Musik", 2, katSprache);

        const teamRechte = [
            overwrite(gid, 0n, BIT(10)),
            overwrite(verifiziert.id, 0n, BIT(10)),
            overwrite(mod.id, BIT(10), 0n)
        ];
        const katTeam = await anlegen("Team", 4, undefined, teamRechte);
        await anlegen("mod-chat", 0, katTeam, teamRechte);

        // Standardkanäle, die Discord automatisch angelegt hat, wieder löschen
        await sleep(400);
        const alle: any[] = (await RestAPI.get({ url: `/guilds/${gid}/channels` })).body;
        for (const c of alle) {
            if (neu.has(c.id)) continue;
            await sleep(400);
            await RestAPI.delete({ url: `/channels/${c.id}` }).catch(() => { });
        }

        // Dir selbst die Admin-Rolle geben
        await sleep(400);
        await RestAPI.put({ url: `/guilds/${gid}/members/${UserStore.getCurrentUser().id}/roles/${admin.id}` }).catch(() => { });

        // Einladungslink (unbegrenzt) für den Verify-Kanal
        const einladung = await post(`/channels/${verifyId}/invites`, { max_age: 0, max_uses: 0, unique: true });
        const link = `https://discord.gg/${einladung.code}`;
        navigator.clipboard.writeText(link).catch(() => { });

        // Torwächter und Willkommensnachricht automatisch einrichten
        settings.store.torServerId = gid;
        settings.store.torKanalId = verifyId;
        settings.store.torRolleId = verifiziert.id;
        settings.store.willkommenKanalId = allgemeinId;
        settings.store.torwaechter = true;

        let geheimnis = settings.store.torGeheimnis;
        if (!geheimnis) {
            geheimnis = zufallsGeheimnis();
            settings.store.torGeheimnis = geheimnis;
        }
        torStart();

        sag([
            `✅ Server „${name}“ ist fertig!`,
            `🔗 Einladung (in die Zwischenablage kopiert): ${link}`,
            "👥 Rollen: Admin (du), Moderator, Verifiziert",
            "📁 Kanäle: verify, allgemein, befehle, mod-chat und 2 Sprachkanäle",
            `🔑 Torwächter-Geheimnis: ${geheimnis}`,
            "(nur an Leute weitergeben, die auf den Server sollen)",
            "",
            "Damit auch andere das Plugin mit den richtigen IDs bekommen, trage diese Zeilen im Code bei TOR_STANDARD ein, bevor du das Update hochlädst:",
            "```ts",
            `serverId: "${gid}",`,
            `kanalId: "${verifyId}",`,
            `rolleId: "${verifiziert.id}"`,
            "```"
        ].join("\n"));
    } catch (e) {
        sag(`❌ Server-Erstellung fehlgeschlagen: ${fehlerText(e)}\nFalls dabei schon ein Server entstanden ist, lösche ihn in Discord und versuche es noch einmal.`);
    }
}

/* ------------------------------------ Torwächter ------------------------------------ */

const verarbeitet = new Set<string>();
let letzterHandshake = 0;
let torTimer: ReturnType<typeof setTimeout> | null = null;

function torKonfiguriert(): boolean {
    return !!(TOR.serverId && TOR.kanalId && TOR.rolleId && settings.store.torGeheimnis);
}

async function hmacHex(text: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw",
        enc.encode(settings.store.torGeheimnis),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
    return Array.from(sig, b => b.toString(16).padStart(2, "0")).join("");
}

/** Mitglied-Seite: sendet den Nachweis (an deine Nutzer-ID gebunden, kann nicht kopiert werden) */
async function handshakeSenden() {
    const me = UserStore.getCurrentUser().id;
    const ts = Date.now();
    const content = `TOR1:${ts}:${await hmacHex(`${me}:${ts}`)}`;
    uebersprungen.add(content); // nicht verschlüsseln
    await sendMessage(TOR.kanalId, { content });
}

/** Mitglied-Seite: sendet den Nachweis, falls man die Rolle noch nicht hat */
async function handshakeWennNoetig() {
    if (!torKonfiguriert()) return;

    const me = UserStore.getCurrentUser();
    const guild = GuildStore.getGuild(TOR.serverId);
    if (!me || !guild || guild.ownerId === me.id) return;

    const member = GuildMemberStore.getMember(TOR.serverId, me.id);
    if (!member || member.roles.includes(TOR.rolleId)) return;

    if (Date.now() - letzterHandshake < 600_000) return; // höchstens alle 10 Minuten
    letzterHandshake = Date.now();
    await handshakeSenden();
}

/** Prüfer-Seite: kontrolliert einen Nachweis und vergibt die Rolle */
async function handshakePruefen(msg: any) {
    if (!settings.store.torwaechter || !torKonfiguriert()) return;
    if (!msg?.id || verarbeitet.has(msg.id)) return;

    const m = /^TOR1:(\d{10,16}):([0-9a-f]{64})$/.exec(msg.content ?? "");
    const autorId: string | undefined = msg.author?.id;
    if (!m || !autorId || msg.author?.bot || autorId === UserStore.getCurrentUser().id) return;
    verarbeitet.add(msg.id);

    const ts = Number(m[1]);
    if (Math.abs(Date.now() - ts) > 7 * 24 * 3_600_000) return; // Nachweise älter als 7 Tage zählen nicht
    if (await hmacHex(`${autorId}:${ts}`) !== m[2]) return;

    try {
        await RestAPI.put({ url: `/guilds/${TOR.serverId}/members/${autorId}/roles/${TOR.rolleId}` });
        await RestAPI.delete({ url: `/channels/${TOR.kanalId}/messages/${msg.id}` }).catch(() => { });
        showNotification({ title: "Torwächter", body: `${msg.author?.username ?? autorId} wurde freigeschaltet.` });
    } catch (e) {
        showNotification({ title: "Torwächter: Rolle konnte nicht vergeben werden", body: fehlerText(e) });
    }
}

function onMessageCreate({ message, optimistic }: any) {
    if (optimistic || !message || message.channel_id !== TOR.kanalId) return;
    handshakePruefen(message).catch(e => console.error("[MeinPlugin] Torwächter:", e));
}

function onGuildCreate({ guild }: any) {
    if (!TOR.serverId || guild?.id !== TOR.serverId) return;
    setTimeout(() => handshakeWennNoetig().catch(e => console.error("[MeinPlugin] Torwächter:", e)), 5000);
}

function torStart() {
    torStop();
    if (!torKonfiguriert()) return;

    // Nach dem Start: eigenen Nachweis senden und verpasste Nachweise nachholen
    torTimer = setTimeout(async () => {
        try {
            await handshakeWennNoetig();
            if (settings.store.torwaechter) {
                const res = await RestAPI.get({ url: `/channels/${TOR.kanalId}/messages`, query: { limit: 50 } });
                for (const m of res.body) await handshakePruefen(m);
            }
        } catch (e) {
            console.error("[MeinPlugin] Torwächter:", e);
        }
    }, 20_000);
}

function torStop() {
    if (torTimer) clearTimeout(torTimer);
    torTimer = null;
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
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("GUILD_CREATE", onGuildCreate);
        torStart();
    },

    stop() {
        removeMessagePreSendListener(preSend);
        removeMessageAccessory("MeinPluginAufdecken");
        FluxDispatcher.unsubscribe("GUILD_MEMBER_ADD", onMemberAdd);
        hintergrundEntfernen();
        updateTimerStoppen();
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("GUILD_CREATE", onGuildCreate);
        torStop();
    }
});
