declare module "zulip-js" {
  interface ZulipConfig {
    username: string;
    apiKey: string;
    realm: string;
  }

  function zulipInit(config: ZulipConfig): Promise<unknown>;
  export default zulipInit;
}
