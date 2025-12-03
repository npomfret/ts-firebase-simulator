import type { DocumentSnapshot } from 'firebase-admin/firestore';
import type { ParamsOf } from 'firebase-functions';
import { Change, FirestoreEvent, onDocumentWritten } from 'firebase-functions/v2/firestore';
import type { IDocumentSnapshot } from './firestore-types';
import type { FirestoreTriggerChange, FirestoreTriggerHandlers, StubFirestoreDatabase } from './StubFirestoreDatabase';

export type TriggerOperation = 'create' | 'update' | 'delete';

export type FirestoreProdTrigger = ReturnType<typeof onDocumentWritten>;

export type FirestoreTriggerDocumentSnapshot = Pick<IDocumentSnapshot, 'id' | 'exists' | 'data'>;

interface FirestoreTriggerData {
    before?: FirestoreTriggerDocumentSnapshot;
    after?: FirestoreTriggerDocumentSnapshot;
}

export interface FirestoreTriggerEvent<TParams extends Record<string, string> = Record<string, string>> {
    readonly params: TParams;
    readonly data: FirestoreTriggerData;
    readonly changeType: TriggerOperation;
}

export type FirestoreTriggerHandler<TParams extends Record<string, string> = Record<string, string>> = (
    event: FirestoreTriggerEvent<TParams>,
) => Promise<unknown>;

type BaseTriggerDefinition<TName extends string = string> = {
    name: TName;
    document: string;
    operations: TriggerOperation[];
};

export interface TriggerDefinition<
    TName extends string = string,
    TParams extends Record<string, string> = Record<string, string>,
> extends BaseTriggerDefinition<TName> {
    createProdTrigger: (handler: FirestoreTriggerHandler<TParams>) => FirestoreProdTrigger;
    mapParams?: (params: Record<string, string>) => TParams;
}

class DocumentSnapshotAdapter implements FirestoreTriggerDocumentSnapshot {
    constructor(private readonly snapshot: DocumentSnapshot) {}

    get id(): string {
        return this.snapshot.id;
    }

    get exists(): boolean {
        return this.snapshot.exists;
    }

    data(): any | undefined {
        return this.snapshot.data();
    }
}

function determineChangeType(
    before?: FirestoreTriggerDocumentSnapshot,
    after?: FirestoreTriggerDocumentSnapshot,
): TriggerOperation {
    const beforeExists = before?.exists ?? false;
    const afterExists = after?.exists ?? false;

    if (!beforeExists && afterExists) {
        return 'create';
    }

    if (beforeExists && !afterExists) {
        return 'delete';
    }

    return 'update';
}

function sanitizeParams(raw: Record<string, string | undefined>): Record<string, string> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string') {
            params[key] = value;
        }
    }
    return params;
}

function adaptProdEvent<TParams extends Record<string, string>>(
    event: FirestoreEvent<Change<DocumentSnapshot> | undefined, ParamsOf<string>>,
    mapParams?: (params: Record<string, string>) => TParams,
): FirestoreTriggerEvent<TParams> {
    const before = event.data?.before ? new DocumentSnapshotAdapter(event.data.before) : undefined;
    const after = event.data?.after ? new DocumentSnapshotAdapter(event.data.after) : undefined;
    const changeType = determineChangeType(before, after);

    const rawParams = sanitizeParams((event.params ?? {}) as Record<string, string | undefined>);
    const params = mapParams ? mapParams(rawParams) : (rawParams as unknown as TParams);

    return {
        params,
        data: { before, after },
        changeType,
    };
}

function adaptStubChange<TParams extends Record<string, string>>(
    change: FirestoreTriggerChange,
    mapParams?: (params: Record<string, string>) => TParams,
): FirestoreTriggerEvent<TParams> {
    const params = mapParams ? mapParams(change.params) : (change.params as unknown as TParams);

    return {
        params,
        data: {
            before: change.before,
            after: change.after,
        },
        changeType: change.type,
    };
}

export function toProdTrigger<
    TName extends string,
    TParams extends Record<string, string> = Record<string, string>,
    TExtra extends Record<string, unknown> = Record<string, never>,
>(
    definition:
        & BaseTriggerDefinition<TName>
        & TExtra
        & {
            region?: string;
            mapParams?: (params: Record<string, string>) => TParams;
        },
): TriggerDefinition<TName, TParams> & TExtra {
    const { region = 'us-central1', mapParams, ...rest } = definition;

    const createProdTrigger = (handler: FirestoreTriggerHandler<TParams>) =>
        onDocumentWritten(
            {
                document: rest.document,
                region,
            },
            async (event) => {
                const adaptedEvent = adaptProdEvent(event, mapParams);
                return handler(adaptedEvent);
            },
        );

    return {
        ...rest,
        mapParams,
        createProdTrigger,
    } as TriggerDefinition<TName, TParams> & TExtra;
}

export function registerTriggerWithStub(
    db: StubFirestoreDatabase,
    definition: TriggerDefinition<any, any>,
    handler: FirestoreTriggerHandler<any>,
): () => void {
    const triggerHandlers: FirestoreTriggerHandlers = {};
    const { mapParams } = definition;

    if (definition.operations.includes('create')) {
        triggerHandlers.onCreate = async (change) => {
            await handler(adaptStubChange(change, mapParams));
        };
    }

    if (definition.operations.includes('update')) {
        triggerHandlers.onUpdate = async (change) => {
            await handler(adaptStubChange(change, mapParams));
        };
    }

    if (definition.operations.includes('delete')) {
        triggerHandlers.onDelete = async (change) => {
            await handler(adaptStubChange(change, mapParams));
        };
    }

    return db.registerTrigger(definition.document, triggerHandlers);
}

export function attachTriggersToStub<
    TDefinition extends TriggerDefinition<any, any>,
>(
    db: StubFirestoreDatabase,
    definitions: ReadonlyArray<TDefinition>,
    resolveHandler: (definition: TDefinition) => FirestoreTriggerHandler<any>,
): () => void {
    const unregisterFns = definitions.map((definition) => registerTriggerWithStub(db, definition, resolveHandler(definition)));

    return () => {
        for (const unregister of unregisterFns) {
            unregister();
        }
    };
}
