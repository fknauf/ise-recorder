import { ActionButton, Button, Content, Dialog, DialogTrigger, Divider, Flex, Heading, Text } from "@adobe/react-spectrum";
import { useAuth } from "react-oidc-context";
import LogOut from "@spectrum-icons/workflow/LogOut";
import Login from "@spectrum-icons/workflow/Login";
import Refresh from "@spectrum-icons/workflow/Refresh";
import User from "@spectrum-icons/workflow/User";
import { IdTokenClaims } from "oidc-client-ts";

const userDisplayName = (claims: IdTokenClaims | undefined) =>
  claims?.preferred_username ?? claims?.name ?? claims?.email ?? "The Nameless";

export function UserMenu() {
  const auth = useAuth();

  const switchUser = async () => {
    const prevUser = auth.user;
    const next = await auth.signinPopup({ max_age: 0, popupAbortOnClose: true });

    if(next === null && prevUser) {
      await auth.events.load(prevUser);
    }
  };

  return (
    <DialogTrigger type="popover">
      <Button variant="primary" aria-label="User menu">
        <User/>
      </Button>
      <Dialog size="S">
        <Heading>
          User Information
        </Heading>
        <Divider/>
        <Content>
          {
            auth.isAuthenticated
              ? <>
                  <Flex direction="column" gap="size-200">
                    <Text>Signed in as {userDisplayName(auth.user?.profile)}</Text>
                    <ActionButton onPress={() => auth.removeUser().catch(() => null)}>
                      <LogOut/>
                      <Text>Sign out</Text>
                    </ActionButton>
                    <ActionButton onPress={switchUser}>
                      <Refresh/>
                      <Text>Reauthenticate</Text>
                    </ActionButton>
                  </Flex>
                </>
              : <>
                  <Flex direction="column" gap="size-200">
                    <Text>Not signed in</Text>
                    <ActionButton onPress={() => auth.signinPopup().catch(() => null)}>
                      <Login/>
                      <Text>Sign in</Text>
                    </ActionButton>
                  </Flex>
                </>
          }
        </Content>
      </Dialog>
    </DialogTrigger>
  );
}
