import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-admin-session, x-file-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: cors });

  const sessionToken = request.headers.get("x-admin-session") ?? "";
  const contentType = request.headers.get("x-file-type") ?? request.headers.get("content-type") ?? "";
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    return Response.json({ error: "invalid_image_type" }, { status: 415, headers: cors });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) {
    return Response.json({ error: "invalid_image_size" }, { status: 413, headers: cors });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data: valid, error: authError } = await admin.rpc("admin_session_valid", { session_token: sessionToken });
  if (authError || !valid) return Response.json({ error: "unauthorized" }, { status: 401, headers: cors });

  const extension = contentType === 'image/webp' ? 'webp' : contentType === 'image/png' ? 'png' : 'jpg';
  const path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await admin.storage.from("product-images").upload(path, bytes, {
    contentType,
    cacheControl: "31536000",
    upsert: false,
  });
  if (uploadError) return Response.json({ error: "upload_failed" }, { status: 500, headers: cors });

  const { data } = admin.storage.from("product-images").getPublicUrl(path);
  return Response.json({ url: data.publicUrl }, { headers: { ...cors, "Cache-Control": "no-store" } });
});
