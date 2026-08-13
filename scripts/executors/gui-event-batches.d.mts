export type GuiInteractionEvent = Readonly<{ type: string; [key: string]: unknown }>;

export type GuiEventBatch<T extends GuiInteractionEvent = GuiInteractionEvent> =
  | Readonly<{ kind: "sequence"; events: T[] }>
  | Readonly<{ kind: "checkpoint"; event: T }>;

export function interactionEventBatches<T extends GuiInteractionEvent>(events: T[]): GuiEventBatch<T>[];
export function interactionEventDeadlineOffsets<T extends GuiInteractionEvent>(events: T[]): number[];
export function checkpointOutputSeen(chunks: readonly { toString(): string }[], expectedOutput: string): boolean;
