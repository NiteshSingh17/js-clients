import type { ReactNode } from "react";
import React, { useContext, useEffect, useState } from "react";
import { GadgetConfigurationContext } from "../../../src/GadgetProvider";
import { useSession } from "../../../src/auth/useSession";
import { isSessionSignedIn } from "../../../src/auth/utils";

/**
 * Renders its `children` if the current `Session` is signed in, otherwise redirects the browser to the `signInPath` configured in the `Provider`. Uses `window.location.assign` to perform the redirect.
 */
export const SignedInOrRedirect = (props: { children: ReactNode }) => {
  const [redirected, setRedirected] = useState(false);
  const session = useSession();
  const isSignedIn = session && isSessionSignedIn(session);
  const context = useContext(GadgetConfigurationContext);
  const { auth } = context ?? {};

  useEffect(() => {
    if (auth && !redirected && !isSignedIn) {
      setRedirected(true);
      window.location.assign(auth.signInPath);
    }
  }, [redirected, isSignedIn, auth]);

  if (isSignedIn) {
    return <>{props.children}</>;
  } else {
    return null;
  }
};