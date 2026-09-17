import { ActionButton, Button, Content, Dialog, DialogTrigger, Divider, Flex, Heading, Text } from "@adobe/react-spectrum";
import { useAuth } from "react-oidc-context";
import User from "@spectrum-icons/workflow/User";

export function UserMenu() {
  const auth = useAuth();

  return (
    <DialogTrigger type="popover">
      <Button variant="primary">
        <User/>
      </Button>
      <Dialog>
        <Heading>
          User Information
        </Heading>
        <Divider/>
        <Content>
          {
            auth.isAuthenticated
              ? <>
                  <Flex direction="column" gap="size-200">
                    <Text>Logged in as {auth.user?.profile.name}</Text>
                    <ActionButton onPress={() => auth.signoutSilent().catch(() => null)}>Sign out</ActionButton>
                  </Flex>
                </>
              : <>
                  <Flex direction="column" gap="size-200">
                    <Text>Not logged in</Text>
                    <ActionButton onPress={() => auth.signinPopup().catch(() => null)}>Sign in</ActionButton>
                  </Flex>
                </>
          }
        </Content>
      </Dialog>
    </DialogTrigger>
  );
}
