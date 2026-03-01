
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
      {
        env.version !== undefined
          ? <Flex direction="column" alignItems="center">
              <GithubIcon/>
              <Text>v{env.version}</Text>
            </Flex>
          : <GithubIcon/>
      }
    </Link>
  );
}

export default GithubLink;
