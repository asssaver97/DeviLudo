import type {
  DemoCredential,
  DemoProfile,
  DemoProvider,
  DemoStoreState,
} from "@/lib/control-plane/demo-store";
import { HttpProblem } from "@/lib/control-plane/http";
import { fingerprintSecret } from "@/lib/security/credentials";
import { PROVIDER_PROBE_CHECKS } from "@/services/inference-gateway/src/provider-probe";

export type LocalCredentialRotationBinding = Readonly<{
  sourceProfile: DemoProfile;
  successorProfile: DemoProfile;
  sourceProvider: DemoProvider;
  successorProvider: DemoProvider | null;
  rotatesCredential: boolean;
}>;

export type LocalCredentialRotationStage = Readonly<{
  credentialId: string;
  replacementId: string;
  bindings: readonly LocalCredentialRotationBinding[];
  providers: readonly Readonly<{ source: DemoProvider; successor: DemoProvider }>[];
}>;

export type LocalCredentialRotationCommit = Readonly<{
  successorProfileRevisionIds: readonly string[];
  successorProviderRevisionIds: readonly string[];
  reboundDefaultCount: number;
  degradedProfileCount: number;
}>;

export async function planLocalCredentialRotation(
  store: DemoStoreState,
  credential: DemoCredential,
  replacementId: string,
): Promise<LocalCredentialRotationStage> {
  if (credential.state !== "ACTIVE" || store.credentials.some((candidate) => candidate.id === replacementId)) rotationRace();
  const activeProfiles = store.profiles.filter((profile) => profile.state === "ACTIVE");
  const directlyAffected = new Set(activeProfiles
    .filter((profile) => profile.credentialVersionId === credential.id)
    .map((profile) => profile.id));
  const affected = new Set(directlyAffected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const profile of activeProfiles) {
      if (!affected.has(profile.id) && profile.fallbackProfileRevisionId
        && affected.has(profile.fallbackProfileRevisionId)) {
        affected.add(profile.id);
        changed = true;
      }
    }
  }

  const sources = activeProfiles.filter((profile) => affected.has(profile.id))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const successorProfileIds = new Map<string, string>();
  for (const profile of sources) {
    successorProfileIds.set(profile.id, await rotationRevisionId("profile", profile.id, replacementId, profile.revision + 1));
  }

  const providerSuccessors = new Map<string, DemoProvider>();
  for (const profile of sources) {
    const provider = servingProvider(store, profile);
    if (!directlyAffected.has(profile.id)) continue;
    if (provider.credentialVersionId !== credential.id) rotationRace();
    if (!providerSuccessors.has(provider.id)) {
      const id = await rotationRevisionId("provider", provider.id, replacementId, provider.revision + 1);
      if (store.providers.some((candidate) => candidate.id === id)) rotationRace();
      providerSuccessors.set(provider.id, {
        ...cloneProvider(provider),
        id,
        revision: provider.revision + 1,
        credentialVersionId: replacementId,
        state: "READY",
        probe: {},
      });
    }
  }

  const createdAt = new Date().toISOString();
  const bindings = sources.map((profile): LocalCredentialRotationBinding => {
    const sourceProvider = servingProvider(store, profile);
    const rotatesCredential = directlyAffected.has(profile.id);
    const successorProvider = rotatesCredential ? providerSuccessors.get(sourceProvider.id) ?? null : null;
    if (rotatesCredential && !successorProvider) rotationRace();
    const successorId = successorProfileIds.get(profile.id);
    if (!successorId || store.profiles.some((candidate) => candidate.id === successorId)) rotationRace();
    const successorProfile: DemoProfile = {
      ...cloneProfile(profile),
      id: successorId,
      revision: profile.revision + 1,
      providerRevisionId: successorProvider?.id ?? profile.providerRevisionId,
      credentialVersionId: rotatesCredential ? replacementId : profile.credentialVersionId,
      fallbackProfileRevisionId: profile.fallbackProfileRevisionId
        ? successorProfileIds.get(profile.fallbackProfileRevisionId) ?? profile.fallbackProfileRevisionId
        : null,
      state: "READY",
      createdAt,
    };
    return Object.freeze({
      sourceProfile: cloneProfile(profile),
      successorProfile,
      sourceProvider: cloneProvider(sourceProvider),
      successorProvider,
      rotatesCredential,
    });
  });
  return Object.freeze({
    credentialId: credential.id,
    replacementId,
    bindings: Object.freeze(bindings),
    providers: Object.freeze([...providerSuccessors.entries()].map(([sourceId, successor]) => {
      const source = store.providers.find((provider) => provider.id === sourceId);
      if (!source) rotationRace();
      return Object.freeze({ source: cloneProvider(source), successor });
    })),
  });
}

export function commitLocalCredentialRotation(
  store: DemoStoreState,
  stage: LocalCredentialRotationStage,
  expectedCredential: DemoCredential,
  replacement: DemoCredential,
  probes: ReadonlyMap<string, Readonly<Record<string, "PASS">>>,
): LocalCredentialRotationCommit {
  const current = store.credentials.find((credential) => credential.id === expectedCredential.id);
  if (!current || current.state !== "ACTIVE" || current.version !== expectedCredential.version
    || current.fingerprint !== expectedCredential.fingerprint || stage.credentialId !== current.id
    || stage.replacementId !== replacement.id || store.credentials.some((credential) => credential.id === replacement.id)) {
    rotationRace();
  }
  for (const binding of stage.bindings) {
    const profile = store.profiles.find((candidate) => candidate.id === binding.sourceProfile.id);
    const provider = store.providers.find((candidate) => candidate.id === binding.sourceProvider.id);
    if (!profile || profile.state !== "ACTIVE" || profile.revision !== binding.sourceProfile.revision
      || profile.providerRevisionId !== binding.sourceProfile.providerRevisionId
      || profile.credentialVersionId !== binding.sourceProfile.credentialVersionId
      || profile.fallbackProfileRevisionId !== binding.sourceProfile.fallbackProfileRevisionId
      || !provider || provider.state !== "ACTIVE" || provider.revision !== binding.sourceProvider.revision
      || provider.credentialVersionId !== binding.sourceProvider.credentialVersionId
      || store.profiles.some((candidate) => candidate.id === binding.successorProfile.id)) rotationRace();
  }
  for (const { successor } of stage.providers) {
    const probe = probes.get(successor.id);
    if (!probe || !probePassed(probe) || store.providers.some((provider) => provider.id === successor.id)) rotationRace();
  }

  current.state = "PREVIOUS";
  current.rotatedAt = replacement.rotatedAt;
  store.credentials.push(replacement);
  for (const { source, successor } of stage.providers) {
    const currentProvider = store.providers.find((provider) => provider.id === source.id);
    if (!currentProvider || currentProvider.state !== "ACTIVE") rotationRace();
    currentProvider.state = "DISABLED";
    store.providers.push({
      ...cloneProvider(successor),
      state: "ACTIVE",
      probe: { ...probes.get(successor.id)! },
    });
  }

  const successorBySource = new Map(stage.bindings.map((binding) => [binding.sourceProfile.id, binding.successorProfile.id]));
  for (const binding of stage.bindings) {
    const source = store.profiles.find((profile) => profile.id === binding.sourceProfile.id);
    if (!source || source.state !== "ACTIVE") rotationRace();
    source.state = "SUPERSEDED";
    store.profiles.push({ ...cloneProfile(binding.successorProfile), state: "ACTIVE" });
  }
  let reboundDefaultCount = 0;
  for (const [scope, profileId] of Object.entries(store.defaults)) {
    const successorId = successorBySource.get(profileId);
    if (successorId) {
      store.defaults[scope] = successorId;
      reboundDefaultCount += 1;
    }
  }

  const sourceProfileIds = new Set(stage.bindings.map((binding) => binding.sourceProfile.id));
  let degradedProfileCount = 0;
  for (const profile of store.profiles) {
    if (sourceProfileIds.has(profile.id) || ["SUPERSEDED", "DISABLED"].includes(profile.state)) continue;
    if (profile.credentialVersionId === current.id
      || (profile.fallbackProfileRevisionId !== null && sourceProfileIds.has(profile.fallbackProfileRevisionId))) {
      profile.state = "DEGRADED";
      degradedProfileCount += 1;
    }
  }
  const supersededProviderIds = new Set(stage.providers.map(({ source }) => source.id));
  for (const provider of store.providers) {
    if (provider.credentialVersionId === current.id && !supersededProviderIds.has(provider.id)) {
      provider.state = "DISABLED";
      provider.probe = {};
    }
  }
  return Object.freeze({
    successorProfileRevisionIds: Object.freeze(stage.bindings.map((binding) => binding.successorProfile.id)),
    successorProviderRevisionIds: Object.freeze(stage.providers.map(({ successor }) => successor.id)),
    reboundDefaultCount,
    degradedProfileCount,
  });
}

function servingProvider(store: DemoStoreState, profile: DemoProfile): DemoProvider {
  const provider = store.providers.find((candidate) => candidate.id === profile.providerRevisionId);
  if (!provider || provider.state !== "ACTIVE" || provider.agent !== profile.agent
    || provider.credentialVersionId !== profile.credentialVersionId || !probePassed(provider.probe)) rotationRace();
  return provider;
}

function probePassed(probe: Readonly<Record<string, "PASS" | "FAIL">>): boolean {
  return Object.keys(probe).length === PROVIDER_PROBE_CHECKS.length
    && PROVIDER_PROBE_CHECKS.every((check) => probe[check] === "PASS");
}

async function rotationRevisionId(
  kind: "profile" | "provider",
  sourceId: string,
  replacementId: string,
  revision: number,
): Promise<string> {
  const digest = await fingerprintSecret(new TextEncoder().encode(`${kind}\0${sourceId}\0${replacementId}`));
  return `${kind}-credential-rotation-${digest.slice(7, 31)}-r${revision}`;
}

function cloneProvider(provider: DemoProvider): DemoProvider {
  return {
    ...provider,
    approvedPorts: [...provider.approvedPorts],
    models: { ...provider.models },
    pricing: { ...provider.pricing },
    governance: { ...provider.governance },
    probe: { ...provider.probe },
  };
}

function cloneProfile(profile: DemoProfile): DemoProfile {
  return { ...profile, budget: { ...profile.budget } };
}

function rotationRace(): never {
  throw new HttpProblem(
    409,
    "CREDENTIAL_ROTATION_RACE",
    "Credential, Provider, Profile or default selection changed before the rotation could commit",
  );
}
