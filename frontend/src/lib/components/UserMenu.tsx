import { ActionIcon, Button, Divider, Popover, Stack, Text } from "@mantine/core";
import { useAppSession } from "../components/SessionProvider";
import { RepeatIcon, SignInIcon, SignOutIcon, UserIcon } from "@phosphor-icons/react";

export function UserMenu() {
  const { isAuthenticated, userName, signout, interactiveSignin, reauthenticate } = useAppSession();

  return (
    <Popover withArrow position="bottom-start" offset={12} arrowPosition="center" arrowSize={12}>
      <Popover.Target>
        <ActionIcon
          variant="outline"
          color="neutral"
          size="xl"
          radius="xl"
          aria-label="User menu"
          data-testid="um-btn-open"
        >
          <UserIcon style={{ width: "70%", height: "70%" }}/>
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack miw={256}>
          <Text>User Information</Text>
          <Divider/>
          {
            isAuthenticated
              ? <Stack>
                  <Text>Signed in as {userName}</Text>
                  <Button onClick={signout} leftSection={<SignOutIcon/>}>Sign out</Button>
                  <Button onClick={reauthenticate} leftSection={<RepeatIcon/>}>Reauthenticate</Button>
                </Stack>
              : <Stack>
                  <Text>Not signed in</Text>
                  <Button onClick={interactiveSignin} leftSection={<SignInIcon/>}>Sign in</Button>
                </Stack>
          }
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
