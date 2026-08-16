declare module "cloudflare:workers" {
  interface ProvidedEnv {
    VOTES: KVNamespace;
    VOTE_COORDINATOR: DurableObjectNamespace;
  }
}
