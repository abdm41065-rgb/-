import type { SupabaseClient } from '@supabase/supabase-js';

let clientPromise: Promise<SupabaseClient> | undefined;

export function getSupabase() {
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(
      'https://qkzgrbdguuvviceoetyi.supabase.co',
      'sb_publishable_3uU7kqWvLI6C_9nCD6tm2g_vgHWbWfn',
    ),
  );
  return clientPromise;
}
