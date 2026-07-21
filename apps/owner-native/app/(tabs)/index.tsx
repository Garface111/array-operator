import { Redirect } from "expo-router";

/** Default tab route → Fleet (desktop home). */
export default function TabsIndex() {
  return <Redirect href="/(tabs)/fleet" />;
}
