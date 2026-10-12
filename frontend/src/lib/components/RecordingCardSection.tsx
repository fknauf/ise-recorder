import { ReactNode } from "react";
import { Accordion, Card, Group, Stack, Text } from "@mantine/core";

interface RecordingCardProps {
  title: string
  testid?: string
  children: ReactNode
}

interface RecordingCardSectionProps {
  id: string
  title: string
  icon?: ReactNode
  children: ReactNode
}

export const RecordingCard = ({ title, testid, children }: Readonly<RecordingCardProps>) =>
  <Card withBorder data-testid={testid}>
    <Stack align="center" h="100%">
      <Text>{title}</Text>
      <Stack w="100%" h="100%" justify="space-between" align="stretch">
        { children }
      </Stack>
    </Stack>
  </Card>;

export const RecordingCardSection = ({ id, title, icon, children }: Readonly<RecordingCardSectionProps>) =>
  <Accordion.Item value={id}>
    <Accordion.Control icon={icon}>
      {title}
    </Accordion.Control>
    <Accordion.Panel>
      <Group wrap="wrap" align="stretch">
        {children}
      </Group>
    </Accordion.Panel>
  </Accordion.Item>;
