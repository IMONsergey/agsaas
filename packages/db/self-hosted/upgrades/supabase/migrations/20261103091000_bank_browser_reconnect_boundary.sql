-- Browser updates must never replace the provider-consent target of a connection.
-- Fresh installations run this incremental migration after the immutable baseline.
REVOKE UPDATE ON public.bank_connections FROM anon, authenticated, PUBLIC;
REVOKE UPDATE (reference_id, expires_at) ON public.bank_connections FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.apps, public.api_keys FROM anon, authenticated;
