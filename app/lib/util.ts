import { Key } from "@adobe/react-spectrum"

export function appendKey(keys: Key[], newKey: Key) {
    if(keys.includes(newKey)) {
        return keys;
    }

    return keys.concat([ newKey ])
}