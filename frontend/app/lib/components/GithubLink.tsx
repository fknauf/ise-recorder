
import { Flex, Link, Text } from "@adobe/react-spectrum";
import { GithubIcon } from "./GithubIcon";
import { useServerEnv } from "../hooks/useServerEnv";

export function GithubLink() {
  const env = useServerEnv();

  return (
    <Link
      href="https://github.com/fknauf/ise-recorder"
      variant="secondary"
      isQuiet
    >
      <Flex direction="column" alignItems="center">
        <GithubIcon/>
        <Text>{env.version}</Text>
      </Flex>
    </Link>
  )
}

export default GithubLink;
