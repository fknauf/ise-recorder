'use client';

import { ActionButton } from "@adobe/react-spectrum";
import { ReactNode } from "react";
import { Flex, Text, View } from '@adobe/react-spectrum';

export interface PreviewCardProps {
    label: string | undefined,
    onRemove: () => void,
    children: Readonly<ReactNode>,
    buttonDisabled: boolean
}

export const PreviewCard = (props: Readonly<PreviewCardProps>) =>
    <View borderWidth="thin" borderColor="light" borderRadius="medium" padding="size-100">
        <Flex direction="column" justifyContent="center" gap="size-100">
            {props.children}
            <Text>{props.label}</Text>
            <ActionButton onPress={props.onRemove} isDisabled={props.buttonDisabled}>Remove</ActionButton>
        </Flex>
    </View>;

export default PreviewCard;
