'use client';

import { ActionButton } from "@adobe/react-spectrum";
import { ReactNode } from "react";
import { Flex, Text, View } from '@adobe/react-spectrum';

export interface PreviewCardProps {
    label: string | undefined,
    onRemove: () => void,
    buttonDisabled: boolean,
    children: Readonly<ReactNode>
}

export const PreviewCard = (
    {
        label,
        onRemove,
        buttonDisabled,
        children
    }: Readonly<PreviewCardProps>
) =>
    <View borderWidth="thin" borderColor="light" borderRadius="medium" padding="size-100">
        <Flex direction="column" justifyContent="center" gap="size-100" height="100%">
            <Text>{label}</Text>
            {children}
            <ActionButton  marginTop="auto" onPress={onRemove} isDisabled={buttonDisabled}>Remove</ActionButton>
        </Flex>
    </View>;
