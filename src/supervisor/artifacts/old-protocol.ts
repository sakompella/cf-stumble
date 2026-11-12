import manifest from "@earendil-works/pi-durable/package.json" with { type: "json" };
import { loadMainFacet, mainFacetCode } from "../../facet/index.js";
import type {
  ConversationHost,
  MainFacetModel,
  MainFacetTarget,
  MainHarnessArtifact,
} from "../../facet/index.js";
import type { GenerationControl } from "../../generation-requests.js";

export const OLD_PROTOCOL_COMPATIBILITY = `pi-durable@${manifest.version}/host-5`;

type OldProtocolTarget = Rpc.DurableObjectBranded &
  Readonly<{ attach(host: ConversationHost, generations?: GenerationControl): Promise<void> }>;

export type OldProtocolLoad = Readonly<{ loaderName: string; model: MainFacetModel }>;

export type AttachableFacet = Readonly<{
  facet: Fetcher<MainFacetTarget>;
  oldProtocol?: Fetcher<OldProtocolTarget>;
}>;

export function mountFacet(
  loader: WorkerLoader,
  facets: DurableObjectState["facets"],
  facetName: string,
  artifact: MainHarnessArtifact,
  oldProtocol?: OldProtocolLoad,
): AttachableFacet {
  if (oldProtocol === undefined) {
    const { facetClass } = loadMainFacet(loader, artifact);

    return { facet: facets.get(facetName, () => ({ class: facetClass })) };
  }

  const worker = loader.get(oldProtocol.loaderName, () => ({
    ...mainFacetCode(artifact),
    env: { MODEL: oldProtocol.model },
  }));

  return {
    facet: facets.get(facetName, () => ({
      class: worker.getDurableObjectClass<MainFacetTarget>("MainFacet"),
    })),
    oldProtocol: facets.get(facetName, () => ({
      class: worker.getDurableObjectClass<OldProtocolTarget>("MainFacet"),
    })),
  };
}

export function attachFacet(
  { facet, oldProtocol }: AttachableFacet,
  host: ConversationHost,
  model: MainFacetModel,
  generations?: GenerationControl,
): Promise<void> {
  return oldProtocol === undefined
    ? facet.attach(host, model, generations)
    : oldProtocol.attach(host, generations);
}
