import { Flex, Heading, Text, View } from "@adobe/react-spectrum";
import { ReactNode } from "react";

interface RecordingCardProps {
  title: string
  testid?: string
  children: ReactNode
}

interface RecordingCardSectionProps {
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
    <Flex direction="column" justifyContent="center" gap="size-100">
      <Text>{title}</Text>
      { children }
    </Flex>
  </View>;

export const RecordingCardSection = ({ title, children }: Readonly<RecordingCardSectionProps>) =>
  <View
    borderWidth="thin"
    borderColor="light"
    borderRadius="medium"
    padding="size-100"
    marginX="size-100"
  >
    <Flex direction="column" gap="size-100">
      <Heading level={4}>
        {title}
      </Heading>
      <Flex direction="row" gap="size-100" wrap>
        {children}
      </Flex>
    </Flex>
  </View>;
