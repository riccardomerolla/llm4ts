import * as Layer from "effect/Layer"
import { ConnectorRegistryLive } from "@llm4ts/core/providers/ConnectorFactories"
import { NodeHttpClientLive } from "./NodeHttpClient.ts"
import { NodeGeminiCliExecutorLive } from "./NodeGeminiCliExecutor.ts"
import { NodePlainFileStoreLive } from "./NodePlainFileStore.ts"
import { NodeProcessExecutorLive } from "./NodeProcessExecutor.ts"
import { NodeTemporaryFilesLive } from "./NodeTemporaryFiles.ts"

export const NodeBoundaryLayers = Layer.mergeAll(
  NodeHttpClientLive,
  NodeProcessExecutorLive,
  NodeTemporaryFilesLive,
  NodeGeminiCliExecutorLive,
  NodePlainFileStoreLive
)

const NodeConnectorRegistryLive = ConnectorRegistryLive.pipe(Layer.provide(NodeBoundaryLayers))

export const NodeRuntimeLive = Layer.merge(NodeBoundaryLayers, NodeConnectorRegistryLive)
