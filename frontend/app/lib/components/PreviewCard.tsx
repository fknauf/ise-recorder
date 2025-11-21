'use client';

import { ActionButton } from "@adobe/react-spectrum";
import { ReactNode } from "react";
import { Flex, Text, View } from '@adobe/react-spectrum';

export interface PreviewCardProps {
    label: string | undefined,
    hasDisabledButtons: boolean,
    onRemove: () => void,
    children: Readonly<ReactNode>
}

export const PreviewCard = (
    {
        label,
        hasDisabledButtons,
        onRemove,
        children
    }: Readonly<PreviewCardProps>
) =>
    <View borderWidth="thin" borderColor="light" borderRadius="medium" padding="size-100">
        <Flex direction="column" justifyContent="center" gap="size-100" height="100%">
            <Text>{label}</Text>
            {children}
            <ActionButton  marginTop="auto" onPress={onRemove} isDisabled={hasDisabledButtons}>Remove</ActionButton>
        </Flex>
    </View>;
