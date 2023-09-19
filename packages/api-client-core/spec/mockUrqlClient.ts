import type { Client, GraphQLRequest, OperationContext, OperationResult, OperationResultSource } from "@urql/core";
import { createRequest, makeErrorResult } from "@urql/core";
import type { DocumentNode, OperationDefinitionNode } from "graphql";
import { find, findLast } from "lodash";
import { act } from "react-dom/test-utils";
import type { Sink, Source, Subject } from "wonka";
import { filter, makeSubject, pipe, subscribe, take, toPromise } from "wonka";
import { $gadgetConnection } from "../src/GadgetConnection.js";

/** Patches a `toPromise` method onto the `Source` passed to it.
 * @param source$ - the Wonka {@link Source} to patch.
 * @returns The passed `source$` with a patched `toPromise` method as a {@link PromisifiedSource}.
 * copied from https://github.com/urql-graphql/urql/blob/656495100ea3861075b70b48516b10914efbcfd6/packages/core/src/utils/streamUtils.ts#L10
 */
export function withPromise<T extends OperationResult>(_source$: Source<T>): OperationResultSource<T> {
  const source$ = ((sink: Sink<T>) => _source$(sink)) as OperationResultSource<T>;
  source$.toPromise = () =>
    pipe(
      source$,
      filter((result) => !result.stale && !result.hasNext),
      take(1),
      toPromise
    );
  source$.then = (onResolve, onReject) => source$.toPromise().then(onResolve, onReject);
  source$.subscribe = (onResult) => subscribe(onResult)(source$);
  return source$;
}

export type MockOperationFn = jest.Mock & {
  subjects: Record<string, Subject<OperationResult>>;
  /**
   * Push a response to any subscribed listeners from an `executeXYZ` call in an urql client.
   *
   * The key word here is "subscribed". If no query/mutation/subscription call has been made yet, the pushed response will be "dropped".
   * One should ensure the appropriate `executeXYZ` call has been made by urql, then call this function.
   */
  pushResponse: (key: string, response: Omit<OperationResult, "operation">) => void;
};

export type MockFetchFn = jest.Mock & {
  requests: { args: any[]; resolve: (response: Response) => void; reject: (error: Error) => void }[];
  pushResponse: (response: Response) => Promise<void>;
};

export interface MockUrqlClient extends Client {
  executeQuery: MockOperationFn;
  executeMutation: MockOperationFn;
  executeSubscription: MockOperationFn;
  [$gadgetConnection]: {
    fetch: MockFetchFn;
  };
  mockFetch: MockFetchFn;
  _react?: any;
}

export const graphqlDocumentName = (doc: DocumentNode) => {
  const lastDefinition: OperationDefinitionNode | undefined = findLast(doc.definitions, { kind: "OperationDefinition" }) as any;
  if (lastDefinition) {
    if (lastDefinition.name) {
      return lastDefinition.name.value;
    }
    const firstSelection = find(lastDefinition.selectionSet.selections, { kind: "Field" }) as any;
    return firstSelection.name.value;
  }
};

/**
 * Create a new function for reading/writing to a mock graphql backend
 */
const newMockOperationFn = (assertions?: (request: GraphQLRequest) => void) => {
  const subjects: Record<string, Subject<OperationResult>> = {};

  const fn = jest.fn((request: GraphQLRequest, options?: Partial<OperationContext>) => {
    const { query } = request;
    const fetchOptions = options?.fetchOptions;
    const key = graphqlDocumentName(query) ?? "unknown";
    subjects[key] ??= makeSubject<OperationResult>();

    if (fetchOptions && typeof fetchOptions != "function") {
      const signal = fetchOptions.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          subjects[key].next(makeErrorResult(null as any, new Error("AbortError")));
        });
      }
    }

    if (assertions) {
      assertions(request);
    }

    return withPromise(subjects[key].source);
  }) as unknown as MockOperationFn;

  fn.subjects = subjects;
  fn.pushResponse = (key, response) => {
    if (!subjects[key]) {
      throw new Error(`No mock client subject started for key ${key}, options are ${Object.keys(subjects).join(", ")}`);
    }
    act(() => {
      subjects[key].next({
        operation: null as any,
        ...response,
      });
      subjects[key].complete();
      delete subjects[key];
    });
  };

  return fn;
};

/**
 * Create a new function for reading/writing to a mock graphql backend
 */
const newMockFetchFn = () => {
  const requests: any[] = [];

  const fn = jest.fn((...args) => {
    return new Promise<Response>((resolve, reject) => {
      requests.push({
        args,
        resolve,
        reject,
      });
    });
  }) as unknown as MockFetchFn;

  fn.requests = requests;
  fn.pushResponse = async (response) => {
    await act(async () => {
      const request = requests.shift();
      if (!request) {
        throw new Error("no requests started for response pushing");
      }
      await request.resolve(response);
    });
  };

  return fn;
};

export const createMockUrqlClient = (assertions?: {
  mutationAssertions?: (request: GraphQLRequest) => void;
  queryAssertions?: (request: GraphQLRequest) => void;
}) => {
  const fetch = newMockFetchFn();

  return {
    executeQuery: newMockOperationFn(assertions?.queryAssertions),
    executeMutation: newMockOperationFn(assertions?.mutationAssertions),
    executeSubscription: newMockOperationFn(),
    [$gadgetConnection]: {
      fetch,
    },
    mockFetch: fetch,
    suspense: true,
    query(query, variables, context) {
      return this.executeQuery(createRequest(query, variables), context);
    },

    subscription(query, variables, context) {
      return this.executeSubscription(createRequest(query, variables), context);
    },
    mutation(query, variables, context) {
      return this.executeMutation(createRequest(query, variables), context);
    },
  } as MockUrqlClient;
};

export const mockUrqlClient = createMockUrqlClient();

beforeEach(() => {
  const fetch = newMockFetchFn();

  mockUrqlClient.executeQuery = newMockOperationFn();
  mockUrqlClient.executeMutation = newMockOperationFn();
  mockUrqlClient.executeSubscription = newMockOperationFn();
  mockUrqlClient[$gadgetConnection] = {
    fetch,
  };
  mockUrqlClient.mockFetch = fetch;
});

afterEach(() => {
  // force clear _react, which useQuery sets on the client if not present
  mockUrqlClient._react = undefined;
  jest.clearAllMocks();
});