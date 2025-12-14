"use client";

import { StateCreator } from "zustand";
import { AppStoreState } from "./store";
import { ServerEnv } from "../utils/serverEnv";

export interface ServerEnvState {
  serverEnv: ServerEnv
}

export const createServerEnvSlice: (env: ServerEnv) => StateCreator<
  AppStoreState,
  [],
  [],
  ServerEnvState
> = env => () => ({
  serverEnv: env
});
