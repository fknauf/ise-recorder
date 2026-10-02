import { Disclosure, DisclosureTitle, DisclosurePanel, Flex, Text, View } from "@adobe/react-spectrum";
import { ReactNode } from "react";

interface RecordingCardProps {
  title: string
  testid?: string
  children: ReactNode
}

interface RecordingCardSectionProps {
  id: string
  title: string
  children: ReactNode
}

export const RecordingCard = ({ title, testid, children }: Readonly<RecordingCardProps>) =>
  <View
    borderWidth="thin"
    borderColor="mid"
    borderRadius="medium"
    padding="size-100"
    data-testid={testid}
  >
    <Flex direction="column" gap="size-100" height="100%" alignItems="center">
      <Text>{title}</Text>
      { children }
    </Flex>
  </View>;

export const RecordingCardSection = ({ id, title, children }: Readonly<RecordingCardSectionProps>) =>
  <Disclosure id={id}>
    <DisclosureTitle>
      {title}
    </DisclosureTitle>
    <DisclosurePanel>
      <Flex direction="row" gap="size-100" wrap>
        {children}
      </Flex>
    </DisclosurePanel>
  </Disclosure>;
