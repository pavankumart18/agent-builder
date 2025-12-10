let supabase = null;
let session = null;
let supabaseUrl = null;
let supabaseKey = null;

// Dynamic loader similar to reference repo to ensure correct module loading
const loadSupabase = async () => {
    // We import from the CDN defined in importmap or directly from esm.sh 
    // The reference used: https://esm.sh/@supabase/supabase-js@2
    const mod = await import("https://esm.sh/@supabase/supabase-js@2");
    return mod;
};

export const Storage = {
    async init(url, key) {
        if (!url || !key) return false;
        supabaseUrl = url;
        supabaseKey = key;

        try {
            const { createClient } = await loadSupabase();
            supabase = createClient(url, key, {
                auth: {
                    detectSessionInUrl: true,
                    persistSession: true,
                    autoRefreshToken: true
                }
            });

            const { data } = await supabase.auth.getSession();
            session = data.session;

            // Listen for auth changes
            supabase.auth.onAuthStateChange((_event, _session) => {
                session = _session;
                // Dispatch event so UI can update without direct coupling if needed
                window.dispatchEvent(new CustomEvent('auth-changed', { detail: session }));
            });
            return true;
        } catch (e) {
            console.error("Supabase init error:", e);
            return false;
        }
    },

    getSession() { return session; },

    async login() {
        if (!supabase) throw new Error("Supabase not configured");

        try {
            // Use the library exactly as requested in the reference
            const popup = await import("supabase-oauth-popup");
            await popup.default(supabase, { provider: 'google' });

        } catch (e) {
            console.warn("Popup auth failed", e);
            // Fallback to strict redirect if popup fails (e.g. blockers)
            const { error } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: window.location.href }
            });
            if (error) throw error;
        }
    },

    async logout() {
        if (!supabase) return;
        await supabase.auth.signOut();
        session = null;
    },

    async listAgents() {
        if (!supabase || !session) return [];
        const { data, error } = await supabase
            .from('agents')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return data || [];
    },

    async saveAgent(agent) {
        if (!supabase || !session) throw new Error("Not logged in");
        // Upsert based on ID
        const payload = {
            id: agent.id, // uuid
            user_id: session.user.id,
            title: agent.title,
            problem: agent.problem,
            plan: agent.plan,
            inputs: agent.inputs, // storing as JSONB usually
            updated_at: new Date()
        };

        const { data, error } = await supabase
            .from('agents')
            .upsert(payload)
            .select()
            .single();

        if (error) throw error;
        return data;
    },

    async deleteAgent(id) {
        if (!supabase || !session) throw new Error("Not logged in");
        const { error } = await supabase.from('agents').delete().eq('id', id);
        if (error) throw error;
    }
};
