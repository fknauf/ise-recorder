import { ActionButton, Button, Content, Dialog, DialogTrigger, Divider, Flex, Heading, Text } from "@adobe/react-spectrum";
import LogOut from "@spectrum-icons/workflow/LogOut";
import Login from "@spectrum-icons/workflow/Login";
import Refresh from "@spectrum-icons/workflow/Refresh";
import User from "@spectrum-icons/workflow/User";
import { useAppSession } from "../components/SessionProvider";

export function UserMenu() {
  const { isAuthenticated, userName, signout, interactiveSignin, reauthenticate } = useAppSession();

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
            isAuthenticated
              ? <>
                  <Flex direction="column" gap="size-200">
                    <Text>Signed in as {userName}</Text>
                    <ActionButton onPress={signout}>
                      <LogOut/>
                      <Text>Sign out</Text>
                    </ActionButton>
                    <ActionButton onPress={reauthenticate}>
                      <Refresh/>
                      <Text>Reauthenticate</Text>
                    </ActionButton>
                  </Flex>
                </>
              : <>
                  <Flex direction="column" gap="size-200">
                    <Text>Not signed in</Text>
                    <ActionButton onPress={interactiveSignin}>
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
