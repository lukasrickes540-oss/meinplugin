import { sendBotMessage } from "@api/Commands";
import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { addMessagePreSendListener, MessageSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, RestAPI, useEffect, UserStore, useState } from "@webpack/common";

// Bei jedem neuen Release erhöhen (z. B. "1.0.1"), sonst erkennt das Auto-Update nichts Neues
const VERSION = "1.2.0";

const Native = VencordNative.pluginHelpers.MeinPlugin as PluginNative<typeof import("./native")>;

// Torwächter: Diese Standardwerte bekommen alle, die das Plugin von dir erhalten.
// Trage hier die IDs deines Servers ein, BEVOR du die Datei auf GitHub hochlädst.
const TOR_STANDARD = {
    serverId: "", // ID deines Discord-Servers
    kanalId: "",  // ID des Verify-Kanals
    rolleId: ""   // ID der Rolle "Verifiziert"
};

// Eigene Einstellungen haben Vorrang vor den Standardwerten
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
        description: "Torwächter: Server-ID (leer = Standardwert aus dem Code)",
        default: ""
    },
    torKanalId: {
        type: OptionType.STRING,
        description: "Torwächter: Verify-Kanal-ID (leer = Standardwert aus dem Code)",
        default: ""
    },
    torRolleId: {
        type: OptionType.STRING,
        description: "Torwächter: Rollen-ID von „Verifiziert“ (leer = Standardwert aus dem Code)",
        default: ""
    },
    auditAktiv: {
        type: OptionType.BOOLEAN,
        description: "Audit-Log: Gelöschte/bearbeitete Nachrichten und Rollenänderungen in den Admin-Kanal schreiben (einrichten mit !auditlog)",
        default: false
    },
    auditServerId: {
        type: OptionType.STRING,
        description: "Audit-Log: ID des überwachten Servers (wird von !auditlog gesetzt)",
        default: ""
    },
    auditKanalId: {
        type: OptionType.STRING,
        description: "Audit-Log: ID des Admin-Kanals für das Protokoll (wird von !auditlog gesetzt)",
        default: ""
    },
    auditLoeschen: {
        type: OptionType.BOOLEAN,
        description: "Audit-Log: Gelöschte Nachrichten protokollieren",
        default: true
    },
    auditBearbeiten: {
        type: OptionType.BOOLEAN,
        description: "Audit-Log: Bearbeitete Nachrichten protokollieren",
        default: true
    },
    auditRollen: {
        type: OptionType.BOOLEAN,
        description: "Audit-Log: Rollenänderungen protokollieren",
        default: true
    },
    zonen: {
        type: OptionType.STRING,
        description: "Unsichtbare Zonen (intern, wird mit !zone verwaltet)",
        default: "[]",
        hidden: true
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
    if (text.startsWith(AUDIT_MARKE)) return <AuditAnzeige text={text.slice(AUDIT_MARKE.length)} />;

    return (
        <div style={{ marginTop: 4, fontSize: "0.9em", opacity: 0.95 }}>
            {text === "" ? "🔒 Versteckte Nachricht (falsches Passwort?)" : `🔓 ${text}`}
        </div>
    );
}

/** Zeigt eine entschlüsselte Audit-Meldung formatiert an (fett, Code, Zeitangaben, Kanalnamen) */
function auditFormat(roh: string): string {
    return roh
        .replace(/<#(\d+)>/g, (_m, id) => `#${ChannelStore.getChannel(id)?.name ?? id}`)
        .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_m, t) => new Date(Number(t) * 1000).toLocaleString("de-DE"))
        .replace(/<(https?:\/\/[^>]+)>/g, "$1");
}

function auditInline(text: string) {
    return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((t, i) => {
        if (t.length > 4 && t.startsWith("**") && t.endsWith("**")) return <strong key={i}>{t.slice(2, -2)}</strong>;
        if (t.length > 2 && t.startsWith("`") && t.endsWith("`")) {
            return (
                <code key={i} style={{ padding: "0 4px", borderRadius: 3, background: "rgba(0, 0, 0, 0.25)" }}>
                    {t.slice(1, -1)}
                </code>
            );
        }
        return t;
    });
}

function AuditAnzeige({ text }: { text: string; }) {
    const teile = auditFormat(text).split("```");
    return (
        <div style={{
            marginTop: 4,
            paddingLeft: 8,
            borderLeft: "3px solid #faa61a",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere"
        }}>
            {teile.map((teil, i) => i % 2 === 1
                ? (
                    <pre key={i} style={{ margin: "4px 0", padding: "6px 8px", borderRadius: 4, background: "rgba(0, 0, 0, 0.25)", whiteSpace: "pre-wrap" }}>
                        {teil.replace(/^\n/, "").replace(/\n$/, "")}
                    </pre>
                )
                : <span key={i}>{auditInline(teil)}</span>
            )}
        </div>
    );
}

/* ---------------------------------- Befehle ---------------------------------- */

const CMD_RE = /^!(gg|op|softban|update|version|kick|ban|unban|mute|unmute|purge|avatar|invites|hilfe|auditlog|serverkopie|zone)\b\s*(.*)$/is;
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

        case "auditlog": {
            const unterbefehl = arg.trim().toLowerCase();

            if (unterbefehl === "aus") {
                settings.store.auditAktiv = false;
                info(channelId, "📋 Audit-Log ausgeschaltet.");
                break;
            }

            if (unterbefehl === "status") {
                info(channelId, auditBereit()
                    ? `📋 Audit-Log ist AN. Protokoll-Kanal: <#${settings.store.auditKanalId}>. Im Zwischenspeicher: ${auditCache.size} Nachrichten.`
                    : "📋 Audit-Log ist AUS. Schreibe !auditlog in deinem Admin-Kanal, um es einzuschalten.");
                break;
            }

            if (!guildId) throw new Error("Nur auf Servern möglich. Schreibe den Befehl im Admin-Kanal deines Servers.");

            settings.store.auditServerId = guildId;
            settings.store.auditKanalId = channelId;
            settings.store.auditAktiv = true;
            rollenVorladen();

            info(channelId, "✅ Audit-Log ist AN. Alle Meldungen landen ab jetzt in diesem Kanal. Das Protokoll wird verschlüsselt gepostet: Nur wer das Plugin und dasselbe Passwort hat, sieht den Inhalt, alle anderen sehen nur den Tarntext. Der Kanal sollte trotzdem nur für Admins sichtbar sein.");
            auditSenden("📋 **Audit-Log gestartet.** Ab jetzt werden gelöschte und bearbeitete Nachrichten sowie Rollenänderungen hier protokolliert.");
            break;
        }

        case "serverkopie": {
            const m = /^(\S+)(?:\s+(.+))?$/s.exec(arg.trim());
            if (!m) throw new Error("Nutzung: !serverkopie <Server-ID> [neuer Name]");
            // Nicht abwarten, sonst blockiert es das Chatfeld
            void serverKopieren(m[1], (m[2] ?? "").trim(), channelId);
            break;
        }

        case "zone": {
            await zonenBefehl(arg.trim(), channelId, guildId);
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
                "`!auditlog` Protokoll in diesem Kanal einschalten (`!auditlog aus` / `!auditlog status`)",
                "`!serverkopie <Server-ID> [Name]` Struktur eines Servers (Rollen, Kanäle, Rechte) kopieren",
                "`!zone neu <Name> <Rolle+Rolle | Rolle>` Kanal, der nur existiert, solange die Bedingung gilt (auch `!zone liste`, `!zone loeschen`, `!zone pruefen`)",
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

/* ------------------------------ Erweitertes Audit-Log ------------------------------ */

type AuditNachricht = {
    id: string;
    autorId: string;
    autor: string;
    inhalt: string;
    anhaenge: string[];
    zeit: number;
};

// Zwischenspeicher: Nur Nachrichten, die dein Discord seit dem Start gesehen hat, sind bekannt
const auditCache = new Map<string, AuditNachricht>();
const rollenCache = new Map<string, string[]>();
const auditWarteschlange: string[] = [];
let auditVerworfen = 0;
let auditSender: ReturnType<typeof setTimeout> | null = null;
let auditVorladeTimer: ReturnType<typeof setTimeout> | null = null;

const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function auditBereit(): boolean {
    const { auditAktiv, auditServerId, auditKanalId } = settings.store;
    return !!(auditAktiv && auditServerId && auditKanalId);
}

function imAuditServer(guildId: string | undefined, channelId: string | undefined): boolean {
    const gid = guildId ?? (channelId ? ChannelStore.getChannel(channelId)?.guild_id : undefined);
    return !!gid && gid === settings.store.auditServerId;
}

/** Entfernt Backticks und verhindert, dass @everyone oder Erwähnungen jemanden anpingen */
function entschaerfen(text: string): string {
    return String(text ?? "").replaceAll("`", "'").replaceAll("@", "@\u200b");
}

function kuerzen(text: string, max = 400): string {
    const t = text ?? "";
    return t.length > max ? t.slice(0, max) + "… (gekürzt)" : t;
}

/** Packt Text in einen Codeblock (darin pingen Erwähnungen nicht) */
function codeblock(text: string): string {
    const sauber = kuerzen(text || "(kein Text)").replaceAll("```", "`\u200b``");
    return "```\n" + sauber + "\n```";
}

const zeitMarke = (ms: number) => `<t:${Math.floor(ms / 1000)}:f>`;
const snowflakeZeit = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n);
const nutzerText = (name: string, id: string) => `\`${entschaerfen(name)}\` (\`${id}\`)`;

// Kennzeichnung im verschlüsselten Text, damit das Plugin Meldungen schön formatiert anzeigt
const AUDIT_MARKE = "#AUDIT#\n";
// Mehr passt (verschlüsselt als unsichtbare Zeichen) nicht in eine Discord-Nachricht
const AUDIT_MAX_BYTES = 440;

/** Teilt einen Text in Stücke, die verschlüsselt je in eine Nachricht passen */
function auditTeilen(text: string): string[] {
    const budget = AUDIT_MAX_BYTES - enc.encode(AUDIT_MARKE).length - 10;
    const roh: string[] = [];
    let aktuell = "";
    let aktuellBytes = 0;

    for (const zeichen of text) {
        const b = enc.encode(zeichen).length;
        if (aktuellBytes + b > budget) {
            const umbruch = aktuell.lastIndexOf("\n");
            if (umbruch > 0) {
                roh.push(aktuell.slice(0, umbruch));
                aktuell = aktuell.slice(umbruch + 1);
            } else {
                roh.push(aktuell);
                aktuell = "";
            }
            aktuellBytes = enc.encode(aktuell).length;
        }
        aktuell += zeichen;
        aktuellBytes += b;
    }
    if (aktuell) roh.push(aktuell);

    // Codeblöcke, die über eine Grenze laufen, in jedem Stück sauber schließen und wieder öffnen
    let offen = false;
    return roh.map(teil => {
        let t = offen ? "```\n" + teil : teil;
        if (((teil.match(/```/g) ?? []).length % 2) === 1) offen = !offen;
        if (offen) t += "\n```";
        return t;
    });
}

/** Schickt Meldungen verschlüsselt und nacheinander (höchstens eine pro Sekunde), damit Discord nicht bremst */
function auditSenden(text: string) {
    if (!auditBereit()) return;
    for (const teil of auditTeilen(text)) {
        if (auditWarteschlange.length >= 150) {
            auditVerworfen++;
            continue;
        }
        auditWarteschlange.push(teil);
    }
    if (!auditSender && auditWarteschlange.length) auditSender = setTimeout(auditLeeren, 300);
}

async function auditLeeren() {
    auditSender = null;
    if (!auditBereit()) {
        auditWarteschlange.length = 0;
        return;
    }

    if (!auditWarteschlange.length && auditVerworfen) {
        auditWarteschlange.push(`⚠️ ${auditVerworfen} weitere Meldungen wurden wegen Überlastung nicht protokolliert.`);
        auditVerworfen = 0;
    }

    const teil = auditWarteschlange.shift();
    if (teil === undefined) return;

    try {
        // Nur Leute mit Plugin und demselben Passwort sehen den Inhalt, alle anderen nur den Tarntext
        const content = await verstecken(AUDIT_MARKE + teil);
        if (content.length > 2000) throw new Error("Meldung zu lang (Tarntext in den Einstellungen kürzen)");
        uebersprungen.add(content); // nicht ein zweites Mal verschlüsseln
        await sendMessage(settings.store.auditKanalId, { content });
    } catch (e) {
        console.error("[MeinPlugin] Audit-Log konnte nicht gesendet werden:", e);
    }

    if (auditWarteschlange.length || auditVerworfen) auditSender = setTimeout(auditLeeren, 1100);
}

function auditMerken(m: any, channelId: string) {
    if (!m?.id || !m.author) return;

    auditCache.set(m.id, {
        id: m.id,
        autorId: m.author.id,
        autor: m.author.username ?? m.author.id,
        inhalt: m.content ?? "",
        anhaenge: (m.attachments ?? []).map((a: any) => a.filename).filter(Boolean),
        zeit: m.timestamp ? new Date(m.timestamp).getTime() : Date.now()
    });

    if (auditCache.size > 5000) {
        const aeltester = auditCache.keys().next().value;
        if (aeltester) auditCache.delete(aeltester);
    }
}

/* --- Nachrichten merken --- */

function auditNachrichtNeu({ message, optimistic, channelId, guildId }: any) {
    if (!auditBereit() || optimistic || !message) return;
    const kanal: string | undefined = channelId ?? message.channel_id;
    if (!kanal || !imAuditServer(guildId, kanal) || kanal === settings.store.auditKanalId) return;
    auditMerken(message, kanal);
}

/** Nachrichten, die beim Öffnen eines Kanals geladen werden, ebenfalls merken */
function auditGeschichte({ channelId, messages }: any) {
    if (!auditBereit() || !Array.isArray(messages)) return;
    if (!imAuditServer(undefined, channelId) || channelId === settings.store.auditKanalId) return;
    for (const m of messages) {
        if (!auditCache.has(m.id)) auditMerken(m, channelId);
    }
}

/* --- Bearbeitet --- */

function auditBearbeitet({ message, guildId }: any) {
    if (!auditBereit() || !settings.store.auditBearbeiten || !message?.id) return;

    const kanal: string | undefined = message.channel_id;
    if (!kanal || !imAuditServer(guildId, kanal) || kanal === settings.store.auditKanalId) return;
    if (typeof message.content !== "string") return; // z. B. nur eine Link-Vorschau wurde ergänzt

    const alt = auditCache.get(message.id);
    if (alt && alt.inhalt === message.content) return;
    if (!alt && !message.edited_timestamp) return;

    const autorId: string = message.author?.id ?? alt?.autorId ?? "?";
    const autor: string = message.author?.username ?? alt?.autor ?? autorId;
    const gid = guildId ?? ChannelStore.getChannel(kanal)?.guild_id;

    auditSenden([
        `✏️ **Nachricht bearbeitet** in <#${kanal}>`,
        `**Autor:** ${nutzerText(autor, autorId)}`,
        `**Zeit:** ${zeitMarke(Date.now())}`,
        "**Vorher:**",
        codeblock(alt ? alt.inhalt : "(unbekannt, die Nachricht wurde vor dem Start von Discord gesendet)"),
        "**Nachher:**",
        codeblock(message.content),
        `<https://discord.com/channels/${gid}/${kanal}/${message.id}>`
    ].join("\n"));

    if (alt) alt.inhalt = message.content;
    else auditMerken(message, kanal);
}

/* --- Gelöscht --- */

function auditGeloescht({ id, channelId, guildId }: any) {
    if (!auditBereit() || !settings.store.auditLoeschen || !id) return;
    if (!imAuditServer(guildId, channelId) || channelId === settings.store.auditKanalId) return;

    const alt = auditCache.get(id);
    auditCache.delete(id);

    const zeilen = [`🗑️ **Nachricht gelöscht** in <#${channelId}>`];
    if (alt) {
        zeilen.push(
            `**Autor:** ${nutzerText(alt.autor, alt.autorId)}`,
            `**Gesendet:** ${zeitMarke(alt.zeit)}`,
            "**Inhalt:**",
            codeblock(alt.inhalt)
        );
        if (alt.anhaenge.length) zeilen.push(`**Anhänge:** ${entschaerfen(alt.anhaenge.join(", "))}`);
    } else {
        zeilen.push(
            `**Gesendet:** ${zeitMarke(snowflakeZeit(id))}`,
            "**Inhalt:** unbekannt (die Nachricht wurde vor dem Start von Discord gesendet oder nie geladen)"
        );
    }
    auditSenden(zeilen.join("\n"));
}

function auditMassenLoeschung({ ids, channelId, guildId }: any) {
    if (!auditBereit() || !settings.store.auditLoeschen || !Array.isArray(ids)) return;
    if (!imAuditServer(guildId, channelId) || channelId === settings.store.auditKanalId) return;

    const zeilen = [`🧹 **${ids.length} Nachrichten auf einmal gelöscht** in <#${channelId}>`];
    for (const id of ids.slice(0, 15)) {
        const m = auditCache.get(id);
        zeilen.push(m
            ? `• ${entschaerfen(m.autor)}: ${entschaerfen(kuerzen(m.inhalt.replace(/\s+/g, " "), 80))}`
            : "• (unbekannte Nachricht)");
    }
    if (ids.length > 15) zeilen.push(`… und ${ids.length - 15} weitere`);

    for (const id of ids) auditCache.delete(id);
    auditSenden(zeilen.join("\n"));
}

/* --- Rollenänderungen --- */

function rollenName(guildId: string, roleId: string): string {
    const rolle = GuildStore.getRole?.(guildId, roleId) ?? GuildStore.getRoles?.(guildId)?.[roleId];
    return entschaerfen(rolle?.name ?? roleId);
}

function rollenVorladen() {
    const gid = settings.store.auditServerId;
    if (!auditBereit() || !gid) return;
    try {
        for (const m of GuildMemberStore.getMembers(gid) ?? []) {
            rollenCache.set(`${gid}:${m.userId}`, [...(m.roles ?? [])]);
        }
    } catch (e) {
        console.error("[MeinPlugin] Rollen konnten nicht vorgeladen werden:", e);
    }
}

async function auditRolle({ guildId, roles, user }: any) {
    if (!auditBereit() || guildId !== settings.store.auditServerId) return;
    if (!user?.id || !Array.isArray(roles)) return;

    const schluessel = `${guildId}:${user.id}`;
    const alt = rollenCache.get(schluessel);
    rollenCache.set(schluessel, [...roles]);
    if (!settings.store.auditRollen || !alt) return;

    const dazu = roles.filter((r: string) => !alt.includes(r));
    const weg = alt.filter(r => !roles.includes(r));
    if (!dazu.length && !weg.length) return;

    // Wer hat es geändert? Steht nur im echten Discord-Audit-Log (Recht "Audit-Log ansehen" nötig)
    let verursacher = "unbekannt";
    try {
        await pause(2000);
        const res = await RestAPI.get({ url: `/guilds/${guildId}/audit-logs`, query: { action_type: 25, limit: 10 } });
        const eintrag = res.body.audit_log_entries.find(
            (e: any) => e.target_id === user.id && Date.now() - snowflakeZeit(e.id) < 20_000
        );
        if (eintrag) {
            const u = res.body.users.find((x: any) => x.id === eintrag.user_id);
            verursacher = nutzerText(u?.username ?? eintrag.user_id, eintrag.user_id);
        }
    } catch {
        // Ohne das Recht bleibt der Verursacher unbekannt
    }

    const zeilen = [`🛡️ **Rollen geändert** für ${nutzerText(user.username ?? user.id, user.id)}`];
    if (dazu.length) zeilen.push(`➕ **Hinzugefügt:** ${dazu.map((r: string) => rollenName(guildId, r)).join(", ")}`);
    if (weg.length) zeilen.push(`➖ **Entfernt:** ${weg.map(r => rollenName(guildId, r)).join(", ")}`);
    zeilen.push(`👤 **Geändert von:** ${verursacher}`, `🕒 ${zeitMarke(Date.now())}`);
    auditSenden(zeilen.join("\n"));
}

/* --- Start und Stopp --- */

function auditStart() {
    auditStop();
    FluxDispatcher.subscribe("MESSAGE_CREATE", auditNachrichtNeu);
    FluxDispatcher.subscribe("MESSAGE_UPDATE", auditBearbeitet);
    FluxDispatcher.subscribe("MESSAGE_DELETE", auditGeloescht);
    FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", auditMassenLoeschung);
    FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", auditGeschichte);
    FluxDispatcher.subscribe("GUILD_MEMBER_UPDATE", auditRolle);
    auditVorladeTimer = setTimeout(rollenVorladen, 10_000);
}

function auditStop() {
    FluxDispatcher.unsubscribe("MESSAGE_CREATE", auditNachrichtNeu);
    FluxDispatcher.unsubscribe("MESSAGE_UPDATE", auditBearbeitet);
    FluxDispatcher.unsubscribe("MESSAGE_DELETE", auditGeloescht);
    FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", auditMassenLoeschung);
    FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", auditGeschichte);
    FluxDispatcher.unsubscribe("GUILD_MEMBER_UPDATE", auditRolle);
    if (auditVorladeTimer) clearTimeout(auditVorladeTimer);
    if (auditSender) clearTimeout(auditSender);
    auditVorladeTimer = null;
    auditSender = null;
    auditWarteschlange.length = 0;
}

/* ------------------------------ Server kopieren ------------------------------ */

/** Wiederholt eine Anfrage, wenn Discord wegen zu vieler Anfragen kurz bremst (Fehler 429) */
async function anfrage<T>(fn: () => Promise<T>): Promise<T> {
    for (let versuch = 0; ; versuch++) {
        try {
            return await fn();
        } catch (e: any) {
            if (e?.status === 429 && versuch < 5) {
                await pause((Number(e.body?.retry_after) || 2) * 1000 + 300);
                continue;
            }
            throw e;
        }
    }
}

/** Kanal aus dem Speicher von Discord in das Format der Schnittstelle umwandeln */
function kanalNormalisieren(c: any) {
    return {
        id: c.id,
        name: c.name,
        type: c.type,
        parent_id: c.parent_id ?? c.parentId ?? null,
        position: c.position ?? 0,
        topic: c.topic,
        nsfw: c.nsfw,
        rate_limit_per_user: c.rateLimitPerUser ?? c.rate_limit_per_user,
        bitrate: c.bitrate,
        user_limit: c.userLimit ?? c.user_limit,
        permission_overwrites: Object.values(c.permissionOverwrites ?? {}).map((o: any) => ({
            id: o.id,
            type: o.type,
            allow: String(o.allow),
            deny: String(o.deny)
        }))
    };
}

async function kanaeleHolen(serverId: string): Promise<any[]> {
    try {
        const res = await anfrage(() => RestAPI.get({ url: `/guilds/${serverId}/channels` }));
        if (Array.isArray(res.body)) return res.body;
    } catch {
        // weiter mit dem lokalen Speicher von Discord
    }
    const lokal = (ChannelStore as any).getMutableGuildChannelsForGuild?.(serverId) ?? {};
    return Object.values(lokal).map(kanalNormalisieren);
}

/** Kopiert Rollen, Kanäle und Rechte eines Servers, in dem du Mitglied bist, in einen neuen Server */
async function serverKopieren(quellId: string, wunschName: string, channelId: string) {
    const sag = (text: string) => info(channelId, text);

    try {
        if (!/^\d{17,20}$/.test(quellId)) throw new Error("Nutzung: !serverkopie <Server-ID> [neuer Name]");

        const quellName: string | undefined = GuildStore.getGuild(quellId)?.name;
        if (!quellName) throw new Error("Diesen Server kenne ich nicht. Du musst Mitglied sein, und die ID muss stimmen.");

        const rollen = Object.values(GuildStore.getRoles(quellId) ?? {}) as any[];
        const everyoneQuelle = rollen.find(r => r.id === quellId);
        const kopierbar = rollen
            .filter(r => r.id !== quellId && !r.managed)
            .sort((a, b) => b.position - a.position); // höchste Rolle zuerst

        const kanaele = await kanaeleHolen(quellId);
        const typ = (t: number): number | null =>
            t === 4 ? 4
                : (t === 2 || t === 13) ? 2
                    : (t === 0 || t === 5 || t === 15 || t === 16) ? 0
                        : null;
        const gueltig = kanaele.filter(c => typ(c.type) !== null);

        const name = (wunschName || `${quellName} (Kopie)`).slice(0, 100);
        sag(`🏗️ Kopiere „${quellName}“: ${kopierbar.length} Rollen und ${gueltig.length} Kanäle. Das kann einige Minuten dauern, bitte nichts schließen.`);

        const neu = (await anfrage(() => RestAPI.post({ url: "/guilds", body: { name, icon: null } }))).body;
        const gid: string = neu.id;

        // Rollen
        const rollenMap = new Map<string, string>([[quellId, gid]]);
        for (const r of kopierbar) {
            await pause(500);
            const nr = (await anfrage(() => RestAPI.post({
                url: `/guilds/${gid}/roles`,
                body: {
                    name: r.name,
                    permissions: String(r.permissions),
                    color: r.color,
                    hoist: !!r.hoist,
                    mentionable: !!r.mentionable
                }
            }))).body;
            rollenMap.set(r.id, nr.id);
        }

        if (everyoneQuelle) {
            await pause(500);
            await anfrage(() => RestAPI.patch({
                url: `/guilds/${gid}/roles/${gid}`,
                body: { permissions: String(everyoneQuelle.permissions) }
            }));
        }

        // Reihenfolge der Rollen übernehmen
        await pause(500);
        await RestAPI.patch({
            url: `/guilds/${gid}/roles`,
            body: [...kopierbar].reverse().map((r, i) => ({ id: rollenMap.get(r.id), position: i + 1 }))
        }).catch(() => { });

        sag(`✅ ${kopierbar.length} Rollen kopiert. Jetzt die Kanäle …`);

        // Kanäle: zuerst Kategorien, dann der Rest
        const kanalMap = new Map<string, string>();
        const neueIds = new Set<string>();
        let ersterTextId: string | undefined;
        let fertig = 0;

        const rechteFuer = (c: any) => (c.permission_overwrites ?? [])
            .filter((o: any) => (o.type === 0 || o.type === "role") && rollenMap.has(o.id))
            .map((o: any) => ({ id: rollenMap.get(o.id), type: 0, allow: String(o.allow), deny: String(o.deny) }));

        const anlegen = async (c: any) => {
            const t = typ(c.type)!;
            const body: any = { name: c.name, type: t, permission_overwrites: rechteFuer(c) };
            if (c.parent_id && kanalMap.has(c.parent_id)) body.parent_id = kanalMap.get(c.parent_id);
            if (t === 0) {
                if (c.topic) body.topic = c.topic;
                body.nsfw = !!c.nsfw;
                if (c.rate_limit_per_user) body.rate_limit_per_user = c.rate_limit_per_user;
            }
            if (t === 2) {
                if (c.bitrate) body.bitrate = Math.min(c.bitrate, 96000);
                if (c.user_limit) body.user_limit = c.user_limit;
            }

            await pause(600);
            const nk = (await anfrage(() => RestAPI.post({ url: `/guilds/${gid}/channels`, body }))).body;
            kanalMap.set(c.id, nk.id);
            neueIds.add(nk.id);
            if (t === 0 && !ersterTextId) ersterTextId = nk.id;

            fertig++;
            if (fertig % 10 === 0) sag(`… ${fertig} von ${gueltig.length} Kanälen erstellt`);
        };

        for (const k of gueltig.filter(c => c.type === 4).sort((a, b) => a.position - b.position)) await anlegen(k);
        for (const c of gueltig.filter(c => c.type !== 4).sort((a, b) => a.position - b.position)) await anlegen(c);

        // Standardkanäle, die Discord automatisch angelegt hat, wieder löschen
        await pause(500);
        const alle: any[] = (await anfrage(() => RestAPI.get({ url: `/guilds/${gid}/channels` }))).body;
        for (const c of alle) {
            if (neueIds.has(c.id)) continue;
            await pause(500);
            await RestAPI.delete({ url: `/channels/${c.id}` }).catch(() => { });
        }

        // Einladung zum neuen Server
        let linkZeile = "";
        if (ersterTextId) {
            try {
                await pause(500);
                const inv = (await anfrage(() => RestAPI.post({
                    url: `/channels/${ersterTextId}/invites`,
                    body: { max_age: 0, max_uses: 0, unique: true }
                }))).body;
                const link = `https://discord.gg/${inv.code}`;
                navigator.clipboard.writeText(link).catch(() => { });
                linkZeile = `🔗 Einladung (in die Zwischenablage kopiert): ${link}`;
            } catch {
                linkZeile = "🔗 Die Einladung konnte nicht erstellt werden, nutze dort !gg.";
            }
        }

        sag([
            `✅ Fertig! „${name}“ ist eine Kopie von „${quellName}“.`,
            `👥 ${kopierbar.length} Rollen, 📁 ${fertig} Kanäle und Kategorien mit Rechten.`,
            linkZeile,
            "ℹ️ Nicht kopiert: Mitglieder, Nachrichten, Emojis, Sticker, Servericon, Bot-Rollen und Rechte einzelner Mitglieder."
        ].filter(Boolean).join("\n"));
    } catch (e) {
        sag(`❌ Kopieren fehlgeschlagen: ${fehlerText(e)}\nFalls dabei schon ein neuer Server entstanden ist, lösche ihn in Discord und versuche es noch einmal.`);
    }
}

/* ------------------------------ Unsichtbare Zonen ------------------------------ */

// Eine Zone ist ein Kanal, der nur existiert, solange eine Bedingung erfüllt ist.
// Bedingung = Liste von "Plätzen". Jeder Platz braucht eine eigene Person mit allen genannten Rollen.
type Zone = { name: string; guildId: string; slots: string[][]; kanalId?: string; };

const ZONE_RECHTE = ((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 6n)).toString(); // sehen, schreiben, Verlauf, Reaktionen
const ZONE_VERSTECKT = (1n << 10n).toString(); // "Kanal ansehen"

let zonenTimer: ReturnType<typeof setTimeout> | null = null;
let zonenIntervall: ReturnType<typeof setInterval> | null = null;
let zonenLaeuft = false;
let zonenNochmal = false;
let zonenLetzterFehler = "";
const zonenErstellt = new Map<string, number>();

function zonenLaden(): Zone[] {
    try {
        const z = JSON.parse(settings.store.zonen || "[]");
        return Array.isArray(z) ? z : [];
    } catch {
        return [];
    }
}

function zonenSpeichern(liste: Zone[]) {
    settings.store.zonen = JSON.stringify(liste);
}

function zoneKanalMerken(z: Zone, kanalId: string | undefined) {
    const liste = zonenLaden();
    const ziel = liste.find(x => x.guildId === z.guildId && x.name === z.name);
    if (ziel) {
        ziel.kanalId = kanalId;
        zonenSpeichern(liste);
    }
    z.kanalId = kanalId;
}

function rolleFinden(guildId: string, text: string): string {
    const t = text.trim();
    const rollen = Object.values(GuildStore.getRoles(guildId) ?? {}) as any[];
    const treffer = /^\d{17,20}$/.test(t)
        ? rollen.find(r => r.id === t)
        : rollen.find(r => String(r.name).toLowerCase() === t.toLowerCase());
    if (!treffer) throw new Error(`Rolle „${t}“ nicht gefunden (Name oder ID prüfen).`);
    return treffer.id;
}

function bedingungLesen(guildId: string, text: string): string[][] {
    const slots = text.split("|").map(slot => slot.split("+").map(r => rolleFinden(guildId, r)));
    if (slots.length > 4) throw new Error("Höchstens 4 Personen (mit | getrennt).");
    return slots;
}

function zoneText(z: Zone): string {
    return z.slots.map(s => s.map(r => rollenName(z.guildId, r)).join(" + ")).join("  UND  ");
}

function zonenMitglieder(guildId: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const m of GuildMemberStore.getMembers(guildId) ?? []) map.set(m.userId, m.roles ?? []);
    return map;
}

/** Prüft, ob sich jeder Platz mit einer anderen Person besetzen lässt. Teilnehmer = alle, die einen Platz füllen könnten. */
function zoneAuswerten(slots: string[][], mitglieder: Map<string, string[]>) {
    const kandidaten = slots.map(slot =>
        [...mitglieder].filter(([, rollen]) => slot.every(r => rollen.includes(r))).map(([id]) => id)
    );

    const belegt = new Set<string>();
    let schritte = 0;
    const suche = (i: number): boolean => {
        if (i === kandidaten.length) return true;
        for (const id of kandidaten[i]) {
            if (belegt.has(id)) continue;
            if (++schritte > 200_000) return false;
            belegt.add(id);
            if (suche(i + 1)) return true;
            belegt.delete(id);
        }
        return false;
    };

    return { erfuellt: slots.length > 0 && suche(0), teilnehmer: new Set(kandidaten.flat()) };
}

const zonenKanalName = (n: string) => n.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 100) || "zone";

async function zoneAbgleichen(z: Zone) {
    const { erfuellt, teilnehmer } = zoneAuswerten(z.slots, zonenMitglieder(z.guildId));
    const schluessel = `${z.guildId}:${z.name}`;
    const frisch = Date.now() - (zonenErstellt.get(schluessel) ?? 0) < 15_000;
    const vorhanden = !!z.kanalId && (frisch || !!ChannelStore.getChannel(z.kanalId));

    if (!erfuellt) {
        if (z.kanalId) {
            if (vorhanden) {
                await pause(300);
                await anfrage(() => RestAPI.delete({ url: `/channels/${z.kanalId}` })).catch(() => { });
            }
            zoneKanalMerken(z, undefined);
        }
        return;
    }

    const sichtbarFuer = [...teilnehmer].slice(0, 90); // Discord erlaubt höchstens 100 Einzelrechte pro Kanal

    if (!vorhanden) {
        const nk = (await anfrage(() => RestAPI.post({
            url: `/guilds/${z.guildId}/channels`,
            body: {
                name: zonenKanalName(z.name),
                type: 0,
                topic: "Unsichtbare Zone: Dieser Kanal existiert nur, solange die Bedingung erfüllt ist.",
                permission_overwrites: [
                    { id: z.guildId, type: 0, allow: "0", deny: ZONE_VERSTECKT },
                    ...sichtbarFuer.map(id => ({ id, type: 1, allow: ZONE_RECHTE, deny: "0" }))
                ]
            }
        }))).body;
        zonenErstellt.set(schluessel, Date.now());
        zoneKanalMerken(z, nk.id);
        return;
    }

    if (frisch) return;

    // Wer den Kanal sehen darf, mit der aktuellen Besetzung abgleichen
    const aktuell = ChannelStore.getChannel(z.kanalId!)?.permissionOverwrites ?? {};
    const bisher = new Set<string>(
        (Object.values(aktuell) as any[]).filter(o => o.type === 1 || o.type === "member").map(o => o.id)
    );

    for (const id of sichtbarFuer) {
        if (bisher.has(id)) continue;
        await pause(300);
        await anfrage(() => RestAPI.put({ url: `/channels/${z.kanalId}/permissions/${id}`, body: { type: 1, allow: ZONE_RECHTE, deny: "0" } }));
    }
    for (const id of bisher) {
        if (sichtbarFuer.includes(id)) continue;
        await pause(300);
        await anfrage(() => RestAPI.delete({ url: `/channels/${z.kanalId}/permissions/${id}` })).catch(() => { });
    }
}

async function zonenPruefen() {
    if (zonenLaeuft) {
        zonenNochmal = true;
        return;
    }
    zonenLaeuft = true;
    try {
        for (const z of zonenLaden()) {
            try {
                await zoneAbgleichen(z);
                zonenLetzterFehler = "";
            } catch (e) {
                zonenLetzterFehler = `${z.name}: ${fehlerText(e)}`;
                console.error("[MeinPlugin] Zone konnte nicht abgeglichen werden:", e);
            }
        }
    } finally {
        zonenLaeuft = false;
        if (zonenNochmal) {
            zonenNochmal = false;
            zonenPlanen();
        }
    }
}

function zonenPlanen(ms = 3000) {
    if (zonenTimer) clearTimeout(zonenTimer);
    zonenTimer = setTimeout(() => void zonenPruefen(), ms);
}

function zonenEreignis({ guildId }: any) {
    if (zonenLaden().some(z => z.guildId === guildId)) zonenPlanen();
}

function zonenStart() {
    zonenStop();
    FluxDispatcher.subscribe("GUILD_MEMBER_UPDATE", zonenEreignis);
    FluxDispatcher.subscribe("GUILD_MEMBER_ADD", zonenEreignis);
    FluxDispatcher.subscribe("GUILD_MEMBER_REMOVE", zonenEreignis);
    zonenIntervall = setInterval(() => zonenPlanen(0), 5 * 60_000);
    zonenPlanen(15_000);
}

function zonenStop() {
    FluxDispatcher.unsubscribe("GUILD_MEMBER_UPDATE", zonenEreignis);
    FluxDispatcher.unsubscribe("GUILD_MEMBER_ADD", zonenEreignis);
    FluxDispatcher.unsubscribe("GUILD_MEMBER_REMOVE", zonenEreignis);
    if (zonenTimer) clearTimeout(zonenTimer);
    if (zonenIntervall) clearInterval(zonenIntervall);
    zonenTimer = null;
    zonenIntervall = null;
}

async function zonenBefehl(arg: string, channelId: string, guildId: string | undefined) {
    const nutzung = [
        "Nutzung: `!zone neu <Name> <Bedingung>` | `!zone liste` | `!zone loeschen <Name>` | `!zone pruefen`",
        "Bedingung: Rollen mit + verbinden (eine Person hat alle), Personen mit | trennen.",
        "Beispiel: `!zone neu geheimraum Mod+Aktiv | Admin`"
    ].join("\n");

    const neu = /^neu\s+(\S+)\s+(.+)$/is.exec(arg);
    if (neu) {
        if (!guildId) throw new Error("Nur auf Servern möglich.");
        const name = neu[1];
        const slots = bedingungLesen(guildId, neu[2]);

        const liste = zonenLaden();
        if (liste.some(z => z.guildId === guildId && z.name.toLowerCase() === name.toLowerCase())) {
            throw new Error("Eine Zone mit diesem Namen gibt es auf diesem Server schon.");
        }
        const zone: Zone = { name, guildId, slots };
        liste.push(zone);
        zonenSpeichern(liste);
        zonenPlanen(500);

        info(channelId, `🌫️ Zone „${entschaerfen(name)}“ angelegt. Sie existiert, solange gilt: ${zoneText(zone)}.\nSichtbar ist sie nur für die passenden Mitglieder. Ich prüfe gleich, ob die Bedingung schon erfüllt ist.`);
        return;
    }

    const [unter, name] = arg.split(/\s+/);
    switch ((unter ?? "").toLowerCase()) {
        case "liste": {
            const liste = zonenLaden();
            if (!liste.length) {
                info(channelId, "🌫️ Es gibt noch keine Zonen. Lege eine an mit `!zone neu <Name> <Bedingung>`.");
                return;
            }
            info(channelId, [
                "🌫️ **Zonen**",
                ...liste.map(z => `• **${entschaerfen(z.name)}**: ${zoneText(z)} → ${z.kanalId ? `aktiv (<#${z.kanalId}>)` : "nicht aktiv"}`),
                zonenLetzterFehler ? `⚠️ Letzter Fehler: ${entschaerfen(zonenLetzterFehler)}` : ""
            ].filter(Boolean).join("\n"));
            return;
        }

        case "loeschen": {
            if (!name) throw new Error(nutzung);
            const liste = zonenLaden();
            const index = liste.findIndex(z => z.name.toLowerCase() === name.toLowerCase() && (!guildId || z.guildId === guildId));
            if (index < 0) throw new Error(`Zone „${name}“ nicht gefunden.`);
            const [weg] = liste.splice(index, 1);
            zonenSpeichern(liste);
            if (weg.kanalId && ChannelStore.getChannel(weg.kanalId)) {
                await anfrage(() => RestAPI.delete({ url: `/channels/${weg.kanalId}` })).catch(() => { });
            }
            info(channelId, `🗑️ Zone „${entschaerfen(weg.name)}“ gelöscht.`);
            return;
        }

        case "pruefen": {
            zonenPlanen(0);
            info(channelId, "🔄 Ich gleiche alle Zonen jetzt ab.");
            return;
        }

        default:
            throw new Error(nutzung);
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
        auditStart();
        zonenStart();
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
        auditStop();
        zonenStop();
    }
});
