import { useAppStore } from "./useAppStore";

export const useServerEnv = () => useAppStore(state => state.serverEnv);
