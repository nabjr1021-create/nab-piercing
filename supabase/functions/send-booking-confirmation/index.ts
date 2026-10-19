import { serve } from "std/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";

const ALLOWED_ORIGINS = new Set([
  "https://nabpiercing.ch",
  "https://www.nabpiercing.ch"
]);

function corsHeaders(origin: string | null = null) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  return h;
}

function escapeHtml(s: string) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CLAIM_STALE_MS = 5 * 60 * 1000; // 5 minutes
const COOLDOWN_MS = 60 * 1000; // 1 minute

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: corsHeaders(origin) });

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: corsHeaders(origin) });
  }

  const booking_id = body?.booking_id;
  const confirmation_token = body?.confirmation_token;
  if (!booking_id || !confirmation_token) {
    return new Response(JSON.stringify({ error: "booking_id_and_token_required" }), { status: 400, headers: corsHeaders(origin) });
  }
  if (typeof confirmation_token !== "string" || confirmation_token.length > 512) {
    return new Response(JSON.stringify({ error: "invalid_token" }), { status: 400, headers: corsHeaders(origin) });
  }

  const callerIp = req.headers.get("x-forwarded-for") || req.conn.remoteAddr?.hostname || "unknown";

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoffIso = new Date(now - CLAIM_STALE_MS).toISOString();

  try {
    const { data: booking, error: readError } = await supabase
      .from("bookings")
      .select(`
        id, location_id, service_id, customer_name, customer_email, customer_phone,
        starts_at, ends_at, status, created_at, confirmation_token,
        confirmation_sent_at, confirmation_sending_started_at, confirmation_message_id
      `)
      .eq("id", booking_id)
      .maybeSingle();

    if (readError) {
      console.error("DB read error", readError);
      return new Response(JSON.stringify({ error: "db_read_error" }), { status: 500, headers: corsHeaders(origin) });
    }
    if (!booking) {
      return new Response(JSON.stringify({ error: "booking_not_found" }), { status: 404, headers: corsHeaders(origin) });
    }

    if (booking.confirmation_token === undefined) {
      console.error("confirmation_token column missing; run migration");
      return new Response(JSON.stringify({ error: "server_misconfigured" }), { status: 500, headers: corsHeaders(origin) });
    }

    if (booking.confirmation_sent_at) {
      return new Response(JSON.stringify({ error: "already_sent" }), { status: 409, headers: corsHeaders(origin) });
    }

    if (booking.confirmation_token !== confirmation_token) {
      return new Response(JSON.stringify({ error: "invalid_token" }), { status: 403, headers: corsHeaders(origin) });
    }

    if (booking.status !== "confirmed") {
      return new Response(JSON.stringify({ error: "not_confirmed", status: booking.status }), { status: 409, headers: corsHeaders(origin) });
    }

    if (booking.confirmation_sending_started_at) {
      const lastAttempt = new Date(booking.confirmation_sending_started_at).getTime();
      if (now - lastAttempt < COOLDOWN_MS) {
        return new Response(JSON.stringify({ error: "too_many_requests" }), { status: 429, headers: corsHeaders(origin) });
      }
    }

    const { data: claimData, error: claimError } = await supabase
      .from("bookings")
      .update({ confirmation_sending_started_at: nowIso })
      .eq("id", booking_id)
      .eq("confirmation_token", confirmation_token)
      .is("confirmation_sent_at", null)
      .or(`confirmation_sending_started_at.is.null,confirmation_sending_started_at.lt.${cutoffIso}`)
      .select("id,confirmation_sending_started_at")
      .maybeSingle();

    if (claimError) {
      console.error("claim error", claimError);
      return new Response(JSON.stringify({ error: "claim_failed" }), { status: 500, headers: corsHeaders(origin) });
    }
    if (!claimData) {
      return new Response(JSON.stringify({ error: "unable_to_claim_or_already_claimed" }), { status: 409, headers: corsHeaders(origin) });
    }

    let locationName = "";
    try {
      if (booking.location_id) {
        const { data: locRow, error: locErr } = await supabase.from("locations").select("name").eq("id", booking.location_id).maybeSingle();
        if (!locErr && locRow) locationName = locRow.name ?? String(booking.location_id);
      }
    } catch (err) {
      console.error("location lookup error", err);
      locationName = String(booking.location_id ?? "");
    }

    let serviceName = "";
    try {
      if (booking.service_id) {
        const { data: svcRow, error: svcErr } = await supabase.from("services").select("name").eq("id", booking.service_id).maybeSingle();
        if (!svcErr && svcRow) serviceName = svcRow.name ?? String(booking.service_id);
      }
    } catch (err) {
      console.error("service lookup error", err);
      serviceName = String(booking.service_id ?? "");
    }

    const startsAtText = booking.starts_at ? new Date(booking.starts_at).toLocaleString("it-CH", { timeZone: "Europe/Zurich" }) : "";

    const html = `<div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;color:#111">
      <h2 style="color:#c8102e;margin-bottom:0.2em">Conferma prenotazione — NAB Piercing</h2>
      <p>Ciao ${escapeHtml(booking.customer_name || "")},</p>
      <p>La tua prenotazione è confermata. Di seguito i dettagli:</p>
      <table>
        <tr><td style="padding:4px 8px;font-weight:600">Data e ora:</td><td style="padding:4px 8px">${escapeHtml(startsAtText)}</td></tr>
        <tr><td style="padding:4px 8px;font-weight:600">Sede:</td><td style="padding:4px 8px">${escapeHtml(locationName)}</td></tr>
        <tr><td style="padding:4px 8px;font-weight:600">Servizio:</td><td style="padding:4px 8px">${escapeHtml(serviceName)}</td></tr>
        <tr><td style="padding:4px 8px;font-weight:600">Telefono:</td><td style="padding:4px 8px">${escapeHtml(booking.customer_phone || "")}</td></tr>
      </table>
      <p style="margin-top:1em">Se hai bisogno di annullare o modificare, contatta lo studio.</p>
      <p>Grazie,<br/>NAB Piercing</p>
    </div>`;

    if (!RESEND_API_KEY) {
      console.error("RESEND_API_KEY missing");
      await supabase.from("bookings").update({ confirmation_sending_started_at: null }).eq("id", booking_id);
      return new Response(JSON.stringify({ error: "email_service_not_configured" }), { status: 500, headers: corsHeaders(origin) });
    }

    let resendMessageId: string | null = null;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: "prenotazioni@nabpiercing.ch",
          to: booking.customer_email,
          subject: "Conferma prenotazione - NAB Piercing",
          html
        })
      });

      const text = await res.text().catch(() => "");
      if (!res.ok) {
        console.error("Resend error", res.status, text);
        await supabase.from("bookings").update({ confirmation_sending_started_at: null }).eq("id", booking_id);
        return new Response(JSON.stringify({ error: "email_send_failed" }), { status: 502, headers: corsHeaders(origin) });
      }

      try {
        const j = JSON.parse(text);
        resendMessageId = j?.id ?? null;
      } catch (_) {
        resendMessageId = null;
      }
    } catch (err) {
      console.error("Resend network error", err);
      await supabase.from("bookings").update({ confirmation_sending_started_at: null }).eq("id", booking_id);
      return new Response(JSON.stringify({ error: "email_send_failed" }), { status: 502, headers: corsHeaders(origin) });
    }

    const { error: finalError } = await supabase.from("bookings").update({
      confirmation_sent_at: new Date().toISOString(),
      confirmation_message_id: resendMessageId,
      confirmation_token: null,
      confirmation_sending_started_at: null
    }).eq("id", booking_id);

    if (finalError) {
      console.error("Final DB update error", finalError);
      return new Response(JSON.stringify({ ok: true, warning: "email_sent_but_db_update_failed" }), { status: 200, headers: corsHeaders(origin) });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders(origin) });

  } catch (err) {
    console.error("Unhandled function error", err);
    return new Response(JSON.stringify({ error: "internal_server_error" }), { status: 500, headers: corsHeaders(origin) });
  }
});
