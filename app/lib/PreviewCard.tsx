'use client';

import { ActionButton } from "@adobe/react-spectrum";
import { ReactNode } from "react";
import { Flex, Text, View } from '@adobe/react-spectrum';

export interface PreviewCardProps {
    deviceLabel: string | undefined,
    onRemove: () => void,
    children: Readonly<ReactNode>
}

export function PreviewCard(
    props: Readonly<PreviewCardProps>
) {
    return (
        <View borderWidth="thin" borderColor="light" borderRadius="medium" padding="size-100">
            <Flex direction="column" justifyContent="center" gap="size-100">
                {props.children}
                <Text>{props.deviceLabel}</Text>
                <ActionButton onPress={props.onRemove}>Remove</ActionButton>
            </Flex>
        </View>
    );
}
