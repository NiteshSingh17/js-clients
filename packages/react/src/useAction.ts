import type { ActionFunction, DefaultSelection, GadgetRecord, LimitToKnownKeys, Select } from "@gadgetinc/api-client-core";
import { actionOperation, capitalizeIdentifier, get, hydrateRecord } from "@gadgetinc/api-client-core";
import { useCallback, useContext, useMemo } from "react";
import type { AnyVariables, OperationContext, UseMutationState } from "urql";
import { GadgetUrqlClientContext } from "./GadgetProvider.js";
import { useGadgetMutation } from "./useGadgetMutation.js";
import { useStructuralMemo } from "./useStructuralMemo.js";
import type { ActionHookResult, ActionHookState, OptionsType } from "./utils.js";
import { ErrorWrapper, noProviderErrorMessage } from "./utils.js";

/**
 * React hook to run a Gadget model action. `useAction` must be passed an action function from an instance of your generated API client library, like `api.user.create` or `api.blogPost.publish`. `useAction` doesn't actually run the action when invoked, but instead returns an action function as the second result for running the action in response to an event.
 *
 * @param action an action function from a model manager in your application's client, like `api.user.create`
 * @param options action options, like selecting the fields in the result
 *
 * @example
 * ```
 * export function CreateUserButton(props: { name: string; email: string }) {
 *   const [{error, fetching, data}, createUser] = useAction(api.user.create, {
 *     select: {
 *       id: true,
 *     },
 *   });
 *
 *   const onClick = () => createUser({
 *     name: props.name,
 *     email: props.email,
 *   });
 *
 *   return (
 *     <>
 *       {error && <>Failed to create user: {error.toString()}</>}
 *       {fetching && <>Creating user...</>}
 *       {data && <>Created user with id={data.id}</>}
 *       <button onClick={onClick}>Create user</button>
 *     </>
 *   );
 * }
 */
export const useAction = <
  GivenOptions extends OptionsType, // currently necessary for Options to be a narrow type (e.g., `true` instead of `boolean`)
  SchemaT,
  F extends ActionFunction<GivenOptions, any, any, SchemaT, any>,
  Options extends F["optionsType"]
>(
  action: F,
  options?: LimitToKnownKeys<Options, F["optionsType"]>
): ActionHookResult<
  F["hasReturnType"] extends true
    ? any
    : GadgetRecord<
        Select<Exclude<F["schemaType"], null | undefined>, DefaultSelection<F["selectionType"], Options, F["defaultSelection"]>>
      >,
  Exclude<F["variablesType"], null | undefined>
> => {
  if (!useContext(GadgetUrqlClientContext)) throw new Error(noProviderErrorMessage);

  const memoizedOptions = useStructuralMemo(options);
  const plan = useMemo(() => {
    return actionOperation(
      action.operationName,
      action.defaultSelection,
      action.modelApiIdentifier,
      action.modelSelectionField,
      action.variables,
      memoizedOptions,
      action.namespace,
      action.isBulk,
      action.hasReturnType
    );
  }, [action, memoizedOptions]);

  const [result, runMutation] = useGadgetMutation<
    GadgetRecord<Select<Exclude<F["schemaType"], null | undefined>, DefaultSelection<F["selectionType"], Options, F["defaultSelection"]>>>,
    F["variablesType"]
  >(plan.query);

  const transformedResult = useMemo(() => processResult(result, action), [result, action]);

  return [
    transformedResult,
    useCallback(
      async (variables: F["variablesType"], context?: Partial<OperationContext>) => {
        variables ??= {};
        if (action.hasAmbiguousIdentifier) {
          if (Object.keys(variables).some((key) => !action.paramOnlyVariables?.includes(key) && key !== action.modelApiIdentifier)) {
            throw Error(`Invalid arguments found in variables. Did you mean to use ({ ${action.modelApiIdentifier}: { ... } })?`);
          }
        }

        let newVariables: Exclude<F["variablesType"], null | undefined>;
        const idVariable = Object.entries(action.variables).find(([key, value]) => key === "id" && value.type === "GadgetID");

        if (action.acceptsModelInput || action.hasCreateOrUpdateEffect) {
          if (
            action.modelApiIdentifier in variables &&
            typeof variables[action.modelApiIdentifier] === "object" &&
            variables[action.modelApiIdentifier] !== null
          ) {
            newVariables = variables;
          } else {
            newVariables = {
              [action.modelApiIdentifier]: {},
            } as Exclude<F["variablesType"], null | undefined>;
            for (const [key, value] of Object.entries(variables)) {
              if (action.paramOnlyVariables?.includes(key)) {
                newVariables[key] = value;
              } else {
                if (idVariable && key === idVariable[0]) {
                  newVariables.id = value;
                } else {
                  newVariables[action.modelApiIdentifier][key] = value;
                }
              }
            }
          }
        } else {
          newVariables = variables;
        }

        // Adding the model's additional typename ensures document cache will properly refresh, regardless of whether __typename was
        // selected (and sometimes we can't even select it, like delete actions!)
        const result = await runMutation(newVariables, {
          ...context,
          additionalTypenames: [...(context?.additionalTypenames ?? []), capitalizeIdentifier(action.modelApiIdentifier)],
        });
        return processResult({ fetching: false, ...result }, action);
      },
      [action, runMutation]
    ),
  ];
};

/** Processes urql's result object into the fancier Gadget result object */
const processResult = <Data, Variables extends AnyVariables>(
  result: UseMutationState<Data, Variables>,
  action: ActionFunction<any, any, any, any, any>
): ActionHookState<any, any> => {
  let error = ErrorWrapper.forMaybeCombinedError(result.error);
  let data = null;
  if (result.data) {
    const dataPath = [action.operationName];
    if (action.namespace) {
      dataPath.unshift(action.namespace);
    }

    const mutationData = get(result.data, dataPath);
    if (mutationData) {
      const errors = mutationData["errors"];
      if (errors && errors[0]) {
        error = ErrorWrapper.forErrorsResponse(errors, error?.response);
      } else {
        data = action.hasReturnType ? mutationData.result : hydrateRecord(result, mutationData[action.modelSelectionField]);
      }
    }
  }

  return { ...result, error, data };
};
